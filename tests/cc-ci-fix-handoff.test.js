const { expect, test, beforeEach } = require('bun:test');
const { mock } = require('bun:test');
const { readFileSync } = require('node:fs');
const { createMockCore, createMockContext, createMockGithub } = require('./helpers.js');
const run = require('../.github/scripts/ci-fix/handoff-github-patch.js');

const ATTEMPT = 'Attempt 1 <!-- claude-ci-fix-attempt -->';
let core, context, github;

beforeEach(() => {
  core = createMockCore();
  context = createMockContext({ serverUrl: 'https://github.example', runId: 42 });
  github = createMockGithub();
  github.rest.issues.updateComment = mock();
  process.env.PR_NUMBER = '7';
});

test('a handoff links the patch artifact, labels the PR and voids the attempt', async () => {
  github.paginate.mockResolvedValue([{ id: 1, user: { type: 'Bot' }, body: ATTEMPT }]);
  await run({ github, context, core });

  const body = github.rest.issues.createComment.mock.calls[0][0].body;
  expect(body).toStartWith('<!-- ci-fix-handoff -->');
  expect(body).toContain('`ci-fix-42` artifact of [this run](https://github.example/test-owner/test-repo/actions/runs/42)');
  expect(body).not.toContain('diff --git');
  expect(github.rest.issues.addLabels.mock.calls[0][0].labels).toEqual(['human:review']);
  const voided = github.rest.issues.updateComment.mock.calls[0][0];
  expect(voided.comment_id).toBe(1);
  expect(voided.body).toContain('<!-- claude-ci-fix-attempt-void -->');
  expect(voided.body).not.toContain('<!-- claude-ci-fix-attempt -->');
});

test('a second handoff updates its comment in place, and a label failure only warns', async () => {
  github.paginate.mockResolvedValue([{ id: 9, user: { type: 'Bot' }, body: '<!-- ci-fix-handoff -->\nold' }]);
  github.rest.issues.addLabels.mockRejectedValue(new Error('label refused'));
  await run({ github, context, core });

  expect(github.rest.issues.createComment).not.toHaveBeenCalled();
  expect(github.rest.issues.updateComment.mock.calls[0][0].comment_id).toBe(9);
  expect(core.warnings[0]).toContain('label refused');
  expect(core.failures).toEqual([]);
});

test('both fixers hand off a .github patch and commit nothing, and the OIDC fixer reads only openhands-write', () => {
  for (const file of ['cc-ci-fix.yml', 'cc-ci-fix-oidc.yml']) {
    const text = readFileSync(`.github/workflows/${file}`, 'utf8');
    const { steps, permissions } = Bun.YAML.parse(text).jobs.publish;
    const byId = Object.fromEntries(steps.map((step) => [step.id || step.name, step]));
    const handoff = byId['Hand off a patch that edits .github files'];
    expect([file, handoff.if]).toEqual([file, "steps.workflow-files.outputs.touched == 'true'"]);
    expect(handoff.with.script).toContain('ci-fix/handoff-github-patch.js');
    expect(permissions['pull-requests']).toBe('write');
    for (const name of ['Apply agent patch', 'commit-token', 'Commit fix to PR branch']) {
      expect([file, name, byId[name].if]).toEqual([file, name, expect.stringContaining("steps.workflow-files.outputs.touched != 'true'")]);
    }
    expect(text).not.toContain('openhands-workflows');
    expect(text).not.toContain('workflow-patch');
  }
  const oidc = Bun.YAML.parse(readFileSync('.github/workflows/cc-ci-fix-oidc.yml', 'utf8')).jobs.publish.steps;
  expect(oidc.find((step) => step.id === 'commit-role').run).toContain('role=openhands-write-${OWNER,,}');
});
