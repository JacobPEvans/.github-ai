const { describe, it, expect, beforeEach, afterEach, mock } = require('bun:test');
const { createMockCore, createMockContext } = require('./helpers.js');

const run = require('../.github/scripts/ci-fix/pr-still-open.js');

function makeGithub(result, error = null) {
  const pullsGet = mock(async () => {
    if (error) throw error;
    return result;
  });
  return { rest: { pulls: { get: pullsGet } } };
}

describe('pr-still-open', () => {
  let core, context;

  beforeEach(() => {
    core = createMockCore();
    context = createMockContext();
    process.env.PR_NUMBER = '42';
  });

  afterEach(() => {
    delete process.env.PR_NUMBER;
  });

  it('sets open=true when the PR is open', async () => {
    const github = makeGithub({ data: { number: 42, state: 'open' } });
    await run({ github, context, core });
    expect(github.rest.pulls.get).toHaveBeenCalledWith({ owner: 'test-owner', repo: 'test-repo', pull_number: 42 });
    expect(core.getOutput('open')).toBe('true');
  });

  it('sets open=false and logs when the PR is closed', async () => {
    const github = makeGithub({ data: { number: 42, state: 'closed' } });
    await run({ github, context, core });
    expect(core.getOutput('open')).toBe('false');
    expect(core.infos).toContain('PR #42 is closed; dropping the fix');
  });

  it('sets open=false with an info line when the PR is not found (404)', async () => {
    const err = new Error('Not Found');
    err.status = 404;
    const github = makeGithub(null, err);
    await run({ github, context, core });
    expect(core.getOutput('open')).toBe('false');
    expect(core.infos).toContain('PR #42 not found; dropping the fix');
  });

  it('rethrows non-404 errors', async () => {
    const err = new Error('Internal Server Error');
    err.status = 500;
    const github = makeGithub(null, err);
    let caught;
    await run({ github, context, core }).catch((e) => { caught = e; });
    expect(caught).toBe(err);
    expect(core.getOutput('open')).toBeUndefined();
  });
});
