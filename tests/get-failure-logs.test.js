const { createMockCore, createMockContext, createMockGithub } = require('./helpers.js');
const run = require('../.github/scripts/ci-fix/get-failure-logs.js');

describe('get-failure-logs', () => {
  let core, context, github;

  beforeEach(() => {
    core = createMockCore();
    context = createMockContext({ payload: { workflow_run: { id: 999 } } });
    github = createMockGithub();
  });

  it('returns logs from failed jobs', async () => {
    github.paginate.mockResolvedValue([
      { name: 'build', conclusion: 'failure', id: 1 },
      { name: 'test', conclusion: 'success', id: 2 },
    ]);
    github.rest.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({
      data: 'line1\nline2\nerror here',
    });
    await run({ github, context, core });
    const logs = core.getOutput('logs');
    expect(logs).toContain('FAILED JOB: build');
    expect(logs).toContain('error here');
    expect(logs).not.toContain('FAILED JOB: test');
  });

  it('sets empty output when no failed jobs', async () => {
    github.paginate.mockResolvedValue([{ name: 'build', conclusion: 'success', id: 1 }]);
    await run({ github, context, core });
    expect(core.getOutput('logs')).toBe('');
  });

  it('includes error message when log download fails', async () => {
    github.paginate.mockResolvedValue([{ name: 'deploy', conclusion: 'failure', id: 3 }]);
    github.rest.actions.downloadJobLogsForWorkflowRun.mockRejectedValue(
      new Error('403 Forbidden')
    );
    await run({ github, context, core });
    const logs = core.getOutput('logs');
    expect(logs).toContain('FAILED JOB: deploy');
    expect(logs).toContain('Could not download logs: 403 Forbidden');
  });

  it('includes logs from multiple failed jobs', async () => {
    github.paginate.mockResolvedValue([
      { name: 'build', conclusion: 'failure', id: 1 },
      { name: 'lint', conclusion: 'failure', id: 2 },
      { name: 'test', conclusion: 'success', id: 3 },
    ]);
    github.rest.actions.downloadJobLogsForWorkflowRun
      .mockResolvedValueOnce({ data: 'build error output' })
      .mockResolvedValueOnce({ data: 'lint error output' });
    await run({ github, context, core });
    const logs = core.getOutput('logs');
    expect(logs).toContain('FAILED JOB: build');
    expect(logs).toContain('build error output');
    expect(logs).toContain('FAILED JOB: lint');
    expect(logs).toContain('lint error output');
    expect(logs).not.toContain('FAILED JOB: test');
  });

  it('truncates logs longer than 60000 characters', async () => {
    github.paginate.mockResolvedValue([{ name: 'build', conclusion: 'failure', id: 1 }]);
    const longLog = 'x'.repeat(70000);
    github.rest.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({
      data: longLog,
    });
    await run({ github, context, core });
    const logs = core.getOutput('logs');
    expect(logs.length).toBeLessThanOrEqual(60000);
  });

  it('uses caller-supplied failed run metadata', async () => {
    context = createMockContext({ payload: {} });
    process.env.FAILURE_RUN_ID = '456';
    github.paginate.mockResolvedValue([{ name: 'build', conclusion: 'failure', id: 1 }]);
    github.rest.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({ data: 'caller log' });

    await run({ github, context, core });

    expect(github.paginate.mock.calls[0][1].run_id).toBe('456');
    expect(core.getOutput('logs')).toContain('caller log');
    delete process.env.FAILURE_RUN_ID;
  });

  it('falls back to the newest failed run on the branch for label-triggered runs', async () => {
    context = createMockContext({ payload: {} });
    process.env.FAILURE_HEAD_BRANCH = 'feat/x';
    github.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: { workflow_runs: [{ id: 777, name: 'AI Merge Gate' }] },
    });
    github.paginate.mockResolvedValue([{ name: 'gate', conclusion: 'failure', id: 9 }]);
    github.rest.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({ data: 'label log' });

    await run({ github, context, core });

    expect(github.rest.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'feat/x', status: 'failure' }),
    );
    expect(github.paginate.mock.calls[0][1].run_id).toBe(777);
    expect(core.getOutput('logs')).toContain('label log');
    delete process.env.FAILURE_HEAD_BRANCH;
  });

  it('fails when neither a run id nor a branch is available', async () => {
    context = createMockContext({ payload: {} });

    await run({ github, context, core });

    expect(core.failures).toEqual(['FAILURE_RUN_ID is required']);
    expect(github.paginate).not.toHaveBeenCalled();
  });

  it('fails when the branch has no failed run', async () => {
    context = createMockContext({ payload: {} });
    process.env.FAILURE_HEAD_BRANCH = 'feat/y';
    github.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: [] } });

    try {
      await run({ github, context, core });
    } finally {
      delete process.env.FAILURE_HEAD_BRANCH;
    }

    expect(core.failures).toEqual(['No failed CI run found for branch feat/y']);
    expect(github.paginate).not.toHaveBeenCalled();
  });
});
