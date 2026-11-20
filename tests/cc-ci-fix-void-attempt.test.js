const { expect, mock, test } = require('bun:test');
const { readFileSync } = require('node:fs');

// The failure reporter voids the attempt marker of a run that could not mint its commit token.
const workflow = Bun.YAML.parse(readFileSync('.github/workflows/cc-ci-fix.yml', 'utf8'));
const step = workflow.jobs['notify-failure'].steps.find((s) => s.name === 'Comment on failure');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const report = new AsyncFunction('github', 'context', 'core', step.with.script);

const ATTEMPT = '<!-- claude-ci-fix-attempt -->';

async function run(commitToken, comments) {
  process.env.PR_NUMBER = '5';
  process.env.COMMIT_TOKEN = commitToken;
  const github = {
    paginate: mock().mockResolvedValue(comments),
    rest: { issues: { listComments: mock(), updateComment: mock().mockResolvedValue({}), createComment: mock().mockResolvedValue({}) } },
  };
  const context = { repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', runId: 9 };
  await report(github, context, {});
  return github.rest.issues.updateComment.mock.calls.map((call) => call[0]);
}

test('publish exposes the commit-token step outcome to the failure reporter', () => {
  expect(workflow.jobs.publish.outputs.commit_token).toBe('${{ steps.commit-token.outcome }}');
  expect(step.env.COMMIT_TOKEN).toBe('${{ needs.publish.outputs.commit_token }}');
});

test('a failed commit-token mint voids the latest attempt marker, so it is not counted', async () => {
  const updates = await run('failure', [
    { id: 1, user: { type: 'Bot' }, body: `${ATTEMPT}\n### CI Auto-Fix Attempt 1/2` },
    { id: 2, user: { type: 'Bot' }, body: `${ATTEMPT}\n### CI Auto-Fix Attempt 2/2` },
  ]);
  const voided = updates.find((u) => u.comment_id === 2);
  expect(voided.body).toContain('<!-- claude-ci-fix-attempt-void -->');
  expect(voided.body).not.toContain(ATTEMPT);
  expect(voided.body).toContain('Not counted: the fix could not be committed.');
  expect(updates.some((u) => u.comment_id === 1)).toBe(false);
});

test('any other failure leaves the attempt counted', async () => {
  for (const outcome of ['success', 'skipped', '']) {
    const updates = await run(outcome, [{ id: 2, user: { type: 'Bot' }, body: `${ATTEMPT}\n### CI Auto-Fix Attempt 1/2` }]);
    expect(updates).toEqual([]);
  }
});

test('a human comment quoting the marker is never edited', async () => {
  const updates = await run('failure', [{ id: 3, user: { type: 'User' }, body: `${ATTEMPT} quoted` }]);
  expect(updates).toEqual([]);
});
