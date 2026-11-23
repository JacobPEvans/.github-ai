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

// OpenBao roles bind verdict.yml and policy-gate.yml. The OIDC gate entry grants
// id-token only to the jobs that call policy-gate.yml.
const OIDC_REUSABLES = {
  'verdict.yml': ['verdict'],
  '_ai-merge-gate-oidc.yml': ['leak', 'security', 'semantic', 'code'],
  'cc-conflict-fix.yml': ['publish'],
  'cc-ci-fix-oidc.yml': ['publish'],
};

for (const [name, workflow] of reusables) {
  test(`${name} requires id-token only in the jobs an OpenBao role binds`, () => {
    expect(workflow.permissions?.['id-token']).toBeUndefined();
    for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
      const expected = (OIDC_REUSABLES[name] ?? []).includes(job) ? 'write' : undefined;
      expect(definition.permissions?.['id-token'], `job ${job}`).toBe(expected);
    }
  });

  test(`${name} jobs that list workflow runs request actions: read`, () => {
    for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
      if (!callsActionsApi(definition)) continue;
      expect(effectivePermissions(workflow, definition)?.actions, `job ${job}`).toBe('read');
    }
  });
}

test('pr-agent and verdict read OpenBao credentials through router-creds before using them', () => {
  const review = Bun.YAML.parse(readFileSync(join(dir, 'ai-review.yml'), 'utf8'));
  const verdictFile = Bun.YAML.parse(readFileSync(join(dir, 'verdict.yml'), 'utf8'));
  const action = Bun.YAML.parse(readFileSync(join('.github', 'actions', 'router-creds', 'action.yml'), 'utf8'));
  const vault = action.runs.steps.find((step) => step.uses?.startsWith('hashicorp/vault-action@'));

  expect(review.jobs.scope.permissions['id-token']).toBeUndefined();
  expect(review.jobs['dependency-bot'].permissions['id-token']).toBeUndefined();
  for (const [job, firstUse] of [[review.jobs['pr-agent'], 'Run PR-Agent review'], [verdictFile.jobs.verdict, 'List the models the router serves for this key']]) {
    const credsIndex = job.steps.findIndex((step) => step.uses === './.ai-workflows/.github/actions/router-creds');
    expect(job.permissions['id-token'], firstUse).toBe('write');
    expect(credsIndex, firstUse).toBeGreaterThan(0);
    expect(job.steps[credsIndex].with, firstUse).toBeUndefined();
    expect(job.steps.findIndex((step) => step.name === firstUse), firstUse).toBeGreaterThan(credsIndex);
  }
  expect(vault.with.role).toBe('ci-ai-review');
  expect(vault.with.path).toBe('github-actions');
  expect(vault.with.jwtGithubAudience).toBe('openbao');
  expect(vault.with.exportEnv).toBe(false);
  expect(action.inputs['key-path'].default).toBe('secret/data/apps/github-actions-pr-review github_actions_pr_review_llm_router_key');
  expect(action.inputs['oss-key-path'].default).toBe('secret/data/apps/github-actions-oss github_actions_oss_llm_router_key');
  expect(action.inputs['url-path'].default).toBe('config/data/ci-ai-review base_url');
});

test('verdict.yml never skips verdict/merge outside this repository', () => {
  const review = Bun.YAML.parse(readFileSync(join(dir, 'ai-review.yml'), 'utf8'));
  const { jobs } = Bun.YAML.parse(readFileSync(join(dir, 'verdict.yml'), 'utf8'));
  const sameRepo = 'github.event.pull_request.head.repo.full_name == github.repository';
  const gate = "github.repository != 'JacobPEvans/.github-ai' || vars.DOGFOOD_SELF_HOSTED == 'true'";

  expect(review.jobs['pr-agent']['runs-on']).toBe('self-hosted');
  expect(review.jobs['pr-agent'].if).toContain(sameRepo);
  // Both run only where pr-agent can obtain credentials: never in this repository unless dogfooding.
  expect(review.jobs['pr-agent'].if).toContain(`(${gate})`);
  expect(jobs['hold-class'].if).toBe(gate);
  expect(jobs.verdict.if).toBe(`!cancelled() && (${gate})`);
  // A fork head runs on a hosted runner and fails before any credential step.
  expect(jobs.verdict['runs-on']).toBe(`\${{ ${sameRepo} && 'self-hosted' || 'ubuntu-26.04' }}`);
  expect(jobs.verdict.steps[0].name).toBe('Require a same-repository head');
  expect(jobs.verdict.steps[0].if).toBe(sameRepo.replace('==', '!='));
  expect(jobs.verdict.environment).toBe("${{ needs.hold-class.outputs.hold == 'true' && 'hold' || '' }}");
  expect(review.jobs.verdict.uses).toBe('./.github/workflows/verdict.yml');
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
