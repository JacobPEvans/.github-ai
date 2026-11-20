const { mock, expect, test } = require('bun:test');
const { readFileSync } = require('node:fs');
const { createMockGithub } = require('./helpers.js');
const { decide, parsePatch, diffRefusal } = require('../.github/scripts/ci-fix/workflow-patch.js');

const context = { repo: { owner: 'test-owner', repo: 'test-repo' } };

function filePatch(path, removed, added, header = '') {
  return [`diff --git a/${path} b/${path}`, header, `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@',
    ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].filter(Boolean).join('\n');
}

function github({ jobs = [{ name: 'Workflow Policy', conclusion: 'failure' }], changed = ['.github/workflows/size.yml'] } = {}) {
  const gh = createMockGithub();
  gh.rest.actions.listJobsForWorkflowRun = mock();
  gh.rest.pulls.listFiles = mock();
  gh.rest.pulls.get.mockResolvedValue({ data: { base: { ref: 'main' } } });
  gh.paginate.mockImplementation(async (fn) => (fn === gh.rest.actions.listJobsForWorkflowRun
    ? jobs : changed.map((filename) => ({ filename }))));
  return gh;
}

const run = (gh, patch) => decide({ github: gh, context, patch, prNumber: 7, runId: 9 });
const fix = filePatch('.github/workflows/size.yml',
  ['    uses: example/action@0123456789012345678901234567890123456789', '    # v1.2.0'],
  ['    timeout-minutes: 5', '    uses: example/action@0123456789012345678901234567890123456789 # v1.2.0']);

test('publishes a workflow-policy fix to a workflow file the pull request changes', async () => {
  expect(await run(github(), fix)).toEqual({ allowed: true, reason: 'workflow fix', baseRef: 'main' });
});

test('a patch without .github paths is not a workflow fix', async () => {
  expect(await run(github(), filePatch('src/a.js', ['a'], ['b']))).toEqual({ allowed: false, reason: 'none' });
});

const pin = (n) => String(n).repeat(40);
const refusals = [
  ['an action edit', filePatch('.github/actions/x/action.yml', ['a'], ['b']), {}, /not a workflow file edit/],
  ['a new workflow file', filePatch('.github/workflows/size.yml', [], ['on: push'], 'new file mode 100644'), {}, /creates or deletes/],
  ['a non-workflow failure', fix, { jobs: [{ name: 'Unit tests', conclusion: 'failure' }] }, /no failed workflow-class job/],
  ['a file the pull request does not change', fix, { changed: ['.github/workflows/other.yml'] }, /does not change/],
  ['a new uses reference', filePatch('.github/workflows/size.yml', [], [`    uses: other/action@${pin(3)} # v2`]), {}, /new uses reference/],
  ['a changed uses pin', filePatch('.github/workflows/size.yml', [`    uses: a/b@${pin(1)} # v1`], [`    uses: a/b@${pin(2)} # v1`]), {}, /new uses reference/],
  ['a new secret', filePatch('.github/workflows/size.yml', [], ['      TOKEN: ${{ secrets.ADMIN_TOKEN }}']), {}, /new secrets reference/],
  ['a widened permission', filePatch('.github/workflows/size.yml', ['      contents: read'], ['      contents: write']), {}, /permission change/],
  ['a new permissions block', filePatch('.github/workflows/size.yml', [], ['permissions: write-all']), {}, /permission change/],
];
for (const [name, patch, options, reason] of refusals) {
  test(`refuses ${name}`, async () => {
    const result = await run(github(options), patch);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(reason);
  });
}

test('a re-commented permission line with the same grant passes the diff rules', () => {
  const files = parsePatch(filePatch('.github/workflows/size.yml', ['  contents: read  # old'], ['  contents: read']));
  expect(diffRefusal(files)).toBe('');
});

test('the publisher reads every commit token from OpenBao after the org checks, never an App key', () => {
  const text = readFileSync('.github/workflows/cc-ci-fix.yml', 'utf8');
  const workflow = Bun.YAML.parse(text);
  const { steps, permissions } = workflow.jobs.publish;
  const ids = steps.map((step) => step.id || step.name);
  expect(permissions['id-token']).toBe('write');
  const order = ['workflow-patch', 'workflow-files', 'Apply agent patch', 'Check the workflow fix', 'commit-role',
    'commit-token', 'Commit fix to PR branch'].map((id) => ids.indexOf(id));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  const byId = Object.fromEntries(steps.map((step) => [step.id || step.name, step]));
  expect(byId['workflow-files'].if).toContain("steps.workflow-patch.outputs.workflow_fix != 'true'");
  expect(byId['commit-role'].run).toContain('route=openhands-workflows');
  expect(byId['commit-role'].run).toContain('route=openhands-write');
  expect(byId['commit-token'].uses).toStartWith('hashicorp/vault-action@');
  expect(byId['commit-token'].with.secrets).toContain('github-openhands/token/');
  expect(byId['Commit fix to PR branch'].with['github-token']).toBe('${{ steps.commit-token.outputs.COMMIT_TOKEN }}');
  expect(byId['Commit fix to PR branch'].env.EXTRA_EXCLUDES).toBe('.gh-shared');
  expect(steps.some((step) => (step.uses || '').startsWith('actions/create-github-app-token@'))).toBe(false);
});
