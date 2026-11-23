const { createMockCore, createMockContext, createMockGithub } = require('./helpers.js');
const run = require('../.github/scripts/ci-fix/check-attempts.js');

const MARKER = '<!-- claude-ci-fix-attempt -->';

describe('check-attempts', () => {
  let core, context, github;

  beforeEach(() => {
    core = createMockCore();
    context = createMockContext();
    github = createMockGithub();
    process.env.PR_NUMBER = '42';
    delete process.env.FIXER_VERSION;
  });

  it('sets should_run=true and attempt=1 with no prior attempts', async () => {
    github.paginate.mockResolvedValue([{ body: 'unrelated comment' }]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('true');
    expect(core.getOutput('attempt')).toBe('1');
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

  it('does not count an attempt marker older than 24 hours', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    github.paginate.mockResolvedValue([{ body: MARKER, created_at: old }, { body: MARKER, created_at: old }, { body: MARKER, created_at: recent }]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('true');
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

  it('counts only attempts by this fixer version, up to six attempts in all', async () => {
    process.env.FIXER_VERSION = 'new';
    const mine = `${MARKER}\n<!-- ci-fix-version:new -->`;
    github.paginate.mockResolvedValue([{ body: MARKER }, { body: `${MARKER}\n<!-- ci-fix-version:old -->` }, { body: mine }]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('true');
    expect(core.getOutput('attempt')).toBe('2');

    github.paginate.mockResolvedValue([...Array(5).fill({ body: MARKER }), { body: mine }]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('false');
  });
});
