const { expect, test } = require('bun:test');
const { readdirSync, readFileSync } = require('fs');
const { join } = require('path');
const { effectivePermissions, isReusable } = require('../.github/scripts/permission-ceiling/ceiling.js');

// A reusable workflow cannot request a permission its caller does not grant,
// and the run then fails at startup. Only the input-free required entry needs
// id-token for its OpenBao OIDC credential path.
//
// The daily-run-limit check lists workflow runs through the Actions API, which
// needs `actions: read`. That grant is not in the standard set: every caller of
// these reusables must grant `actions: read` itself, or the run fails at startup.
const dir = join('.github', 'workflows');
const ACTIONS_API_CHECK = 'check-daily-limit.js';

function callsActionsApi(job) {
  return (job.steps ?? []).some((step) => String(step.with?.script ?? '').includes(ACTIONS_API_CHECK));
}

const reusables = readdirSync(dir)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => [name, Bun.YAML.parse(readFileSync(join(dir, name), 'utf8'))])
  .filter(([, workflow]) => isReusable(workflow));

test('finds the reusable workflows that consumers call', () => {
  expect(reusables.map(([name]) => name)).toContain('cc-ci-fix.yml');
});

test('finds the reusable workflows whose daily-limit check needs actions: read', () => {
  const names = reusables
    .filter(([, workflow]) => Object.values(workflow.jobs ?? {}).some(callsActionsApi))
    .map(([name]) => name);
  expect(names).toContain('cc-next-steps.yml');
  expect(names).toContain('cc-code-simplifier.yml');
  expect(names).toContain('best-practices.yml');
});

for (const [name, workflow] of reusables) {
  test(`${name} does not require id-token from reusable callers`, () => {
    expect(workflow.permissions?.['id-token']).toBeUndefined();
    for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
      expect(definition.permissions?.['id-token'], `job ${job}`).toBeUndefined();
    }
  });

  test(`${name} jobs that list workflow runs request actions: read`, () => {
    for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
      if (!callsActionsApi(definition)) continue;
      expect(effectivePermissions(workflow, definition)?.actions, `job ${job}`).toBe('read');
    }
  });
}

test('the input-free AI Review entry fetches OpenBao credentials before running PR-Agent', () => {
  const workflow = Bun.YAML.parse(readFileSync(join(dir, 'ai-review.yml'), 'utf8'));
  const agent = workflow.jobs['pr-agent'];
  const steps = agent.steps;
  const vaultIndex = steps.findIndex((step) => step.uses?.startsWith('hashicorp/vault-action@'));
  const reviewIndex = steps.findIndex((step) => step.name === 'Run PR-Agent review');

  expect(workflow.jobs['pr-agent'].permissions['id-token']).toBe('write');
  expect(workflow.jobs.scope.permissions['id-token']).toBeUndefined();
  expect(workflow.jobs['dependency-bot'].permissions['id-token']).toBeUndefined();
  expect(agent['runs-on']).toBe('self-hosted');
  expect(agent.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  expect(vaultIndex).toBeGreaterThan(0);
  expect(reviewIndex).toBeGreaterThan(vaultIndex);
  expect(steps[vaultIndex].with.role).toBe('ci-ai-review');
  expect(steps[vaultIndex].with.path).toBe('github-actions');
  expect(steps[vaultIndex].with.jwtGithubAudience).toBe('openbao');
  expect(steps[vaultIndex].with.exportEnv).toBe(false);
  expect(workflow.env.OPENBAO_ROUTER_KEY_PATH).toBe('secret/data/apps/github-actions-pr-review github_actions_pr_review_llm_router_key');
  expect(workflow.env.OPENBAO_ROUTER_OSS_KEY_PATH).toBe('secret/data/apps/github-actions-oss github_actions_oss_llm_router_key');
  expect(workflow.env.OPENBAO_ROUTER_URL_PATH).toBe('config/data/ci-ai-review base_url');
});

test('PR-Agent keeps its existing secret interface and uses the reachable open-source role by default', () => {
  const workflow = Bun.YAML.parse(readFileSync(join(dir, 'pr-agent.yml'), 'utf8'));
  const reusable = workflow.on.workflow_call;

  expect(reusable.inputs.oss_model.default).toBe('review-oss');
  expect(reusable.inputs.timeout_minutes.default).toBe(5);
  expect(reusable.secrets.LLM_ROUTER_BASE_URL.required).toBe(true);
  expect(reusable.secrets.LLM_ROUTER_API_KEY.required).toBe(true);
  expect(reusable.secrets.LLM_ROUTER_OSS_API_KEY).toBeDefined();
  expect(workflow.jobs['pr-agent'].permissions['id-token']).toBeUndefined();
  expect(workflow.jobs['pr-agent'].steps.some((step) => step.uses?.startsWith('hashicorp/vault-action@'))).toBe(false);
});
