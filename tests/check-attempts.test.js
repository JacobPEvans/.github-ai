const { createHash } = require('node:crypto');
const { createMockCore, createMockContext, createMockGithub } = require('./helpers.js');
const run = require('../.github/scripts/ci-fix/check-attempts.js');

const MARKER = '<!-- claude-ci-fix-attempt -->';
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_HEAD = 'f0e1d2c3b4a5968778695a4b3c2d1e0f98765432';

const signature = (parts) =>
  createHash('sha256').update([...parts].sort().join('|')).digest('hex').slice(0, 12);

const attemptKey = (headSha, parts) => `${headSha.slice(0, 12)}-${signature(parts)}`;

const keyedMarker = (key) => `<!-- claude-ci-fix-attempt key=${key} -->`;

const failedJob = (name, stepName) => ({
  name,
  conclusion: 'failure',
  steps: [
    { name: 'Setup', conclusion: 'success' },
    { name: stepName, conclusion: 'failure' },
  ],
});

describe('check-attempts', () => {
  let core, context, github;

  beforeEach(() => {
    core = createMockCore();
    context = createMockContext();
    github = createMockGithub();
    process.env.PR_NUMBER = '42';
    delete process.env.FAILURE_RUN_ID;
  });

  it('sets should_run=true and attempt=1 with no prior attempts', async () => {
    github.paginate.mockResolvedValue([{ body: 'unrelated comment' }]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('true');
    expect(core.getOutput('attempt')).toBe('1');
    expect(core.getOutput('attempt_key')).toBe('');
  });

  it('sets should_run=true and attempt=2 with one prior attempt', async () => {
    github.paginate.mockResolvedValue([{ body: MARKER }]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('true');
    expect(core.getOutput('attempt')).toBe('2');
  });

  it('sets should_run=false when 2 attempt markers found', async () => {
    github.paginate.mockResolvedValue([{ body: MARKER }, { body: MARKER }]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('false');
    expect(core.getOutput('attempt')).toBe('2');
  });

  it('null body comment does not throw (bug fix)', async () => {
    github.paginate.mockResolvedValue([{ body: null }, { body: MARKER }]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('true');
  });

  it('calls setFailed when PR_NUMBER is invalid', async () => {
    process.env.PR_NUMBER = 'invalid';
    await run({ github, context, core });
    expect(core.setFailed).toHaveBeenCalled();
  });

  it('derives the attempt key from the failed run head sha and failing job/step names', async () => {
    process.env.FAILURE_RUN_ID = '12345';
    github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { head_sha: HEAD_SHA } });
    github.paginate
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([failedJob('build', 'Run tests')]);
    await run({ github, context, core });
    expect(core.getOutput('attempt_key')).toBe(attemptKey(HEAD_SHA, ['build::Run tests']));
  });

  it('skips when a prior comment already carries the same attempt key', async () => {
    process.env.FAILURE_RUN_ID = '12345';
    const key = attemptKey(HEAD_SHA, ['build::Run tests']);
    github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { head_sha: HEAD_SHA } });
    github.paginate
      .mockResolvedValueOnce([{ body: `${keyedMarker(key)}\n### CI Auto-Fix Attempt 1/2` }])
      .mockResolvedValueOnce([failedJob('build', 'Run tests')]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('false');
    expect(core.getOutput('attempt')).toBe('1');
    expect(core.getOutput('attempt_key')).toBe(key);
    expect(core.infos).toContain(`duplicate attempt for ${key}`);
  });

  it('runs again when the head is unchanged but the failing step signature differs', async () => {
    process.env.FAILURE_RUN_ID = '12345';
    const priorKey = attemptKey(HEAD_SHA, ['build::Run tests']);
    github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { head_sha: HEAD_SHA } });
    github.paginate
      .mockResolvedValueOnce([{ body: keyedMarker(priorKey) }])
      .mockResolvedValueOnce([failedJob('build', 'Lint')]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('true');
    expect(core.getOutput('attempt')).toBe('2');
    expect(core.getOutput('attempt_key')).toBe(attemptKey(HEAD_SHA, ['build::Lint']));
  });

  it('runs again when the signature is unchanged but the head sha differs', async () => {
    process.env.FAILURE_RUN_ID = '12345';
    const priorKey = attemptKey(HEAD_SHA, ['build::Run tests']);
    github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { head_sha: OTHER_HEAD } });
    github.paginate
      .mockResolvedValueOnce([{ body: keyedMarker(priorKey) }])
      .mockResolvedValueOnce([failedJob('build', 'Run tests')]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('true');
    expect(core.getOutput('attempt')).toBe('2');
    expect(core.getOutput('attempt_key')).toBe(attemptKey(OTHER_HEAD, ['build::Run tests']));
  });

  it('counts legacy markers toward the per-PR cap', async () => {
    process.env.FAILURE_RUN_ID = '12345';
    github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { head_sha: HEAD_SHA } });
    github.paginate
      .mockResolvedValueOnce([{ body: MARKER }, { body: MARKER }])
      .mockResolvedValueOnce([failedJob('build', 'Run tests')]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('false');
    expect(core.getOutput('attempt')).toBe('2');
    expect(core.getOutput('attempt_key')).toBe(attemptKey(HEAD_SHA, ['build::Run tests']));
  });

  it('reports the total marker count when skipping a duplicate', async () => {
    process.env.FAILURE_RUN_ID = '12345';
    const key = attemptKey(HEAD_SHA, ['build::Run tests']);
    const otherKey = attemptKey(HEAD_SHA, ['build::Lint']);
    github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { head_sha: HEAD_SHA } });
    github.paginate
      .mockResolvedValueOnce([{ body: keyedMarker(key) }, { body: keyedMarker(otherKey) }])
      .mockResolvedValueOnce([failedJob('build', 'Run tests')]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('false');
    expect(core.getOutput('attempt')).toBe('2');
  });

  it('keeps the legacy cap-only behavior when FAILURE_RUN_ID is unset', async () => {
    delete process.env.FAILURE_RUN_ID;
    github.paginate.mockResolvedValue([{ body: MARKER }]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('true');
    expect(core.getOutput('attempt')).toBe('2');
    expect(core.getOutput('attempt_key')).toBe('');
    expect(github.rest.actions.getWorkflowRun).not.toHaveBeenCalled();
  });

  it('falls back to the cap-only behavior when the run lookup fails', async () => {
    process.env.FAILURE_RUN_ID = '12345';
    github.rest.actions.getWorkflowRun.mockRejectedValue(new Error('403 Forbidden'));
    github.paginate.mockResolvedValue([{ body: MARKER }, { body: MARKER }]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('false');
    expect(core.getOutput('attempt')).toBe('2');
    expect(core.getOutput('attempt_key')).toBe('');
  });
});
