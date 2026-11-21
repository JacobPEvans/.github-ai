const { expect, test } = require('bun:test');
const { readFileSync } = require('fs');
const { join } = require('path');

const workflow = (name) => Bun.YAML.parse(readFileSync(join('.github', 'workflows', name), 'utf8'));
const ciFix = workflow('cc-ci-fix.yml');
const oidc = workflow('cc-ci-fix-oidc.yml');

test('the OIDC entry is the same graph apart from the publish job', () => {
  const without = (jobs) => Object.fromEntries(Object.entries(jobs).filter(([name]) => name !== 'publish'));
  expect(without(oidc.jobs)).toEqual(without(ciFix.jobs));
  expect(oidc.on).toEqual(ciFix.on);
  expect(oidc.permissions).toEqual(ciFix.permissions);
  expect(oidc.concurrency).toEqual(ciFix.concurrency);
});

test('only the OIDC entry publish job grants id-token: write and reads its token from OpenBao', () => {
  expect(oidc.jobs.publish.permissions).toEqual({ contents: 'write', 'id-token': 'write', 'pull-requests': 'read' });
  expect(ciFix.jobs.publish.permissions['id-token']).toBeUndefined();
  const uses = (job) => job.steps.map((step) => step.uses || '').join('\n');
  expect(uses(oidc.jobs.publish)).toContain('hashicorp/vault-action@');
  expect(uses(oidc.jobs.publish)).not.toContain('create-github-app-token');
});
