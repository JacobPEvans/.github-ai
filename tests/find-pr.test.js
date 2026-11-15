const { beforeEach, describe, expect, it, mock } = require('bun:test');
const { createMockCore, createMockContext, createMockGithub } = require('./helpers.js');
const run = require('../.github/scripts/ci-fix/find-pr.js');

describe('find-pr', () => {
  let core, context, github;

  beforeEach(() => {
    core = createMockCore();
    context = createMockContext({
      payload: { workflow_run: { head_branch: 'feat/my-feature' } },
    });
    github = createMockGithub();
  });

  it('sets pr_number when open PR found for branch', async () => {
    github.rest.pulls.list.mockResolvedValue({ data: [{ number: 42 }] });
    await run({ github, context, core });
    expect(core.getOutput('pr_number')).toBe('42');
  });

  it('sets empty pr_number when no PR found', async () => {
    github.rest.pulls.list.mockResolvedValue({ data: [] });
    await run({ github, context, core });
    expect(core.getOutput('pr_number')).toBe('');
  });

  it('resolves a merge queue branch to its pull request and that pull request branch', async () => {
    for (const branch of [
      `gh-readonly-queue/main/pr-42-${'b'.repeat(40)}`,
      `refs/heads/gh-readonly-queue/release/v2/pr-42-${'b'.repeat(40)}`,
    ]) {
      core = createMockCore();
      context = createMockContext({ payload: { workflow_run: { event: 'merge_group', head_branch: branch } } });
      github.rest.pulls.get = mock().mockResolvedValue({ data: { number: 42, state: 'open', head: { ref: 'feat/pr-branch', repo: { full_name: 'test-owner/test-repo' } } } });
      await run({ github, context, core });
      expect(github.rest.pulls.get.mock.calls[0][0].pull_number, branch).toBe(42);
      expect(core.getOutput('pr_number'), branch).toBe('42');
      expect(core.getOutput('head_branch'), branch).toBe('feat/pr-branch');
    }
    expect(github.rest.pulls.list).not.toHaveBeenCalled();
  });

  it('gives no pull request number when the queue entry is already closed', async () => {
    context = createMockContext({ payload: { workflow_run: { event: 'merge_group', head_branch: `gh-readonly-queue/main/pr-7-${'c'.repeat(40)}` } } });
    github.rest.pulls.get = mock().mockResolvedValue({ data: { number: 7, state: 'closed', head: { ref: 'feat/done', repo: { full_name: 'test-owner/test-repo' } } } });
    await run({ github, context, core });
    expect(core.getOutput('pr_number')).toBe('');
  });

  it('gives no pull request number when the queued pull request comes from a fork', async () => {
    context = createMockContext({ payload: { workflow_run: { event: 'merge_group', head_branch: `gh-readonly-queue/main/pr-8-${'d'.repeat(40)}` } } });
    github.rest.pulls.get = mock().mockResolvedValue({ data: { number: 8, state: 'open', head: { ref: 'main', repo: { full_name: 'someone/test-repo' } } } });
    await run({ github, context, core });
    expect(core.getOutput('pr_number')).toBe('');
  });

  it('reads a queue-shaped branch name as an ordinary branch when the run is not a merge queue run', async () => {
    const branch = `gh-readonly-queue/main/pr-9-${'e'.repeat(40)}`;
    context = createMockContext({ payload: { workflow_run: { event: 'pull_request', head_branch: branch } } });
    github.rest.pulls.get = mock();
    github.rest.pulls.list.mockResolvedValue({ data: [{ number: 51 }] });
    await run({ github, context, core });
    expect(github.rest.pulls.get).not.toHaveBeenCalled();
    expect(core.getOutput('head_branch')).toBe(branch);
    expect(core.getOutput('pr_number')).toBe('51');
  });

  it('passes an ordinary branch through as the branch to fix', async () => {
    github.rest.pulls.list.mockResolvedValue({ data: [{ number: 42 }] });
    await run({ github, context, core });
    expect(core.getOutput('head_branch')).toBe('feat/my-feature');
  });

  it('uses caller-supplied failed branch metadata', async () => {
    context = createMockContext({ payload: {} });
    process.env.FAILURE_HEAD_BRANCH = 'feat/caller-context';
    github.rest.pulls.list.mockResolvedValue({ data: [{ number: 43 }] });

    await run({ github, context, core });

    expect(github.rest.pulls.list.mock.calls[0][0].head).toBe('test-owner:feat/caller-context');
    expect(core.getOutput('pr_number')).toBe('43');
    delete process.env.FAILURE_HEAD_BRANCH;
  });
});
