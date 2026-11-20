const { createMockCore, createMockContext, createMockGithub } = require('./helpers.js');
const run = require('../.github/scripts/ci-fix/post-attempt-comment.js');

const MARKER = '<!-- claude-ci-fix-attempt -->';

describe('post-attempt-comment', () => {
  let core, context, github;

  beforeEach(() => {
    core = createMockCore();
    context = createMockContext();
    github = createMockGithub();
    process.env.PR_NUMBER = '10';
    process.env.ATTEMPT = '1';
    delete process.env.DRY_RUN;
    delete process.env.ATTEMPT_KEY;
    github.rest.issues.createComment.mockResolvedValue({});
  });

  it('posts comment with marker and attempt number', async () => {
    await run({ github, context, core });
    expect(github.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 10,
        body: expect.stringContaining(MARKER),
      })
    );
    const body = github.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain('Attempt 1/2');
  });

  it('labels dry-run attempts while retaining the per-PR tracking marker', async () => {
    process.env.DRY_RUN = 'true';
    await run({ github, context, core });

    const body = github.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain(MARKER);
    expect(body).toContain('Dry run: no patch was published.');
  });

  it('falls back to ? when ATTEMPT env is missing (bug fix)', async () => {
    delete process.env.ATTEMPT;
    await run({ github, context, core });
    const body = github.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain('?/2');
  });

  it('posts the keyed marker when ATTEMPT_KEY is set', async () => {
    process.env.ATTEMPT_KEY = 'a1b2c3d4e5f6-0123456789ab';
    await run({ github, context, core });
    const body = github.rest.issues.createComment.mock.calls[0][0].body;
    expect(body.split('\n')[0]).toBe('<!-- claude-ci-fix-attempt key=a1b2c3d4e5f6-0123456789ab -->');
  });

  it('uses the legacy marker when ATTEMPT_KEY is empty', async () => {
    process.env.ATTEMPT_KEY = '';
    await run({ github, context, core });
    const body = github.rest.issues.createComment.mock.calls[0][0].body;
    expect(body.split('\n')[0]).toBe(MARKER);
  });

  it('calls setFailed when PR_NUMBER is invalid', async () => {
    process.env.PR_NUMBER = 'invalid';
    await run({ github, context, core });
    expect(core.setFailed).toHaveBeenCalled();
    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
  });
});
