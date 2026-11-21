const { expect, test } = require('bun:test');
const { readFileSync, readdirSync, statSync } = require('fs');
const { join } = require('path');

const workflow = (name) => Bun.YAML.parse(readFileSync(join('.github', 'workflows', name), 'utf8'));
const ciFix = workflow('cc-ci-fix.yml');
const oidc = workflow('cc-ci-fix-oidc.yml');
const GATE_JOBS = ['should-fix', 'check-daily-limit', 'post-attempt-comment', 'get-failure-details'];
const script = (step) => step.with?.script;

test('the OIDC entry is three jobs deep, the org needs-depth limit', () => {
  const depth = (id) => 1 + Math.max(0, ...[].concat(oidc.jobs[id].needs || []).map(depth));
  for (const id of Object.keys(oidc.jobs)) expect(depth(id)).toBeLessThanOrEqual(3);
  expect(Object.keys(oidc.jobs)).toEqual(['should-fix', 'fix', 'publish', 'notify-failure']);
  expect(oidc.on).toEqual(ciFix.on);
  expect(oidc.permissions).toEqual(ciFix.permissions);
  expect(oidc.concurrency).toEqual(ciFix.concurrency);
});

test('should-fix runs the four gate jobs\' steps in order with exactly their union of permissions', () => {
  const union = {};
  for (const id of GATE_JOBS) {
    for (const [scope, level] of Object.entries(ciFix.jobs[id].permissions)) {
      if (union[scope] !== 'write') union[scope] = level;
    }
  }
  expect(oidc.jobs['should-fix'].permissions).toEqual(union);
  expect(oidc.jobs['should-fix'].if).toBe(ciFix.jobs['should-fix'].if);
  const scripts = (steps) => steps.map(script).filter(Boolean);
  expect(scripts(oidc.jobs['should-fix'].steps)).toEqual(GATE_JOBS.flatMap((id) => scripts(ciFix.jobs[id].steps)));
});

test('fix is cc-ci-fix.yml\'s fix job reading its gate outputs from should-fix', () => {
  const renamed = JSON.parse(JSON.stringify(ciFix.jobs.fix)
    .replaceAll('needs.check-daily-limit.outputs.should_run', 'needs.should-fix.outputs.daily_should_run')
    .replaceAll('needs.get-failure-details.outputs.failure_logs', 'needs.should-fix.outputs.failure_logs'));
  renamed.needs = ['should-fix'];
  expect(oidc.jobs.fix).toEqual(renamed);
});

test('only the publish job grants id-token: write and reads its token from OpenBao', () => {
  for (const [id, job] of Object.entries(oidc.jobs)) {
    if (id !== 'publish') expect(job.permissions['id-token']).toBeUndefined();
  }
  expect(oidc.jobs.publish.permissions).toEqual({ contents: 'write', 'id-token': 'write', 'pull-requests': 'write' });
  expect(JSON.stringify(ciFix)).not.toContain('id-token: write');
  const uses = (job) => job.steps.map((step) => step.uses || '').join('\n');
  expect(uses(oidc.jobs.publish)).toContain('hashicorp/vault-action@');
  expect(uses(oidc.jobs.publish)).not.toContain('create-github-app-token');
  expect(uses(oidc.jobs['should-fix']) + uses(oidc.jobs.fix)).not.toContain('hashicorp/vault-action@');
});

test('the publisher reads its commit token from the github/token mount, and no workflow or action names github-openhands', () => {
  const vault = oidc.jobs.publish.steps.find((step) => (step.uses || '').startsWith('hashicorp/vault-action@'));
  expect(vault.with.secrets.trim()).toBe('github/token/${{ steps.commit-role.outputs.role }} token | COMMIT_TOKEN ;');
  const files = ['workflows', 'actions'].flatMap((dir) =>
    readdirSync(join('.github', dir), { recursive: true }).map((f) => join('.github', dir, String(f))));
  const named = files.filter((f) => statSync(f).isFile() && readFileSync(f, 'utf8').includes('github-openhands'));
  expect(named).toEqual([]);
});

test('failures report with cc-ci-fix.yml\'s reporter; only publish can void the attempt', () => {
  const reporter = script(ciFix.jobs['notify-failure'].steps.find((s) => s.name === 'Comment on failure'));
  const own = oidc.jobs.publish.steps.at(-1);
  expect(own.if).toBe('failure()');
  expect(script(own)).toBe(reporter);
  expect(own.env.COMMIT_TOKEN).toBe('${{ steps.commit-token.outcome }}');
  const notify = oidc.jobs['notify-failure'];
  expect(notify.needs).toEqual(['should-fix', 'fix']);
  expect(script(notify.steps[0])).toBe(reporter);
  expect(notify.steps[0].env.COMMIT_TOKEN).toBeUndefined();
});
