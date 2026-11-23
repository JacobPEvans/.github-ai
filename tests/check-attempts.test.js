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

  it('counts only attempts by this fixer version, and stops after four attempts in a row that published nothing', async () => {
    process.env.FIXER_VERSION = 'new';
    const at = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const comments = [50, 40, 30, 20].map((m) => ({ body: MARKER, created_at: at(m) }))
      .concat({ body: `${MARKER}\n<!-- ci-fix-version:new -->`, created_at: at(10) });
    const fix = (m) => ({ commit: { message: 'fix: resolve CI failure (auto-fix attempt 1)', committer: { date: at(m) } } });
    const withCommits = (commits) => github.paginate.mockImplementation(
      async (method) => (method === github.rest.pulls.listCommits ? commits : comments));

    withCommits([fix(60)]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('false');

    withCommits([fix(60), fix(25)]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('true');
    expect(core.getOutput('attempt')).toBe('2');
  });
});
