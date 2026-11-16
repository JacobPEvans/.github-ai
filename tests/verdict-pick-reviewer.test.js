const { describe, it, expect, beforeEach, afterEach, mock } = require('bun:test');
const path = require('path');
const { createMockCore, createMockContext } = require('./helpers.js');

const run = require('../.github/scripts/verdict/pick-reviewer.js');

const FAMILIES_FILE = path.join(__dirname, '../.github/scripts/verdict/model-families.json');
const HEAD_SHA = 'abc1234def5678';

function makeGithub(headSha, commits) {
  const pullsGet = mock(async () => ({ data: { head: { sha: headSha } } }));
  const paginate = mock(async () => commits);
  const github = {
    rest: {
      pulls: {
        get: pullsGet,
        listCommits: 'listCommits',
      },
    },
    paginate,
  };
  return { github, pullsGet, paginate };
}

describe('pick-reviewer', () => {
  let core, context;

  beforeEach(() => {
    core = createMockCore();
    context = createMockContext();
    process.env.PR_NUMBER = '42';
    process.env.HEAD_SHA = HEAD_SHA;
    process.env.PR_AUTHOR = 'test-author';
    process.env.FAMILIES_FILE = FAMILIES_FILE;
    process.env.VISIBILITY = 'private';
    process.env.ROUTER_MODELS = 'medium\nreview-oss\nstandard';
  });

  afterEach(() => {
    delete process.env.PR_NUMBER;
    delete process.env.HEAD_SHA;
    delete process.env.PR_AUTHOR;
    delete process.env.FAMILIES_FILE;
    delete process.env.VISIBILITY;
    delete process.env.ROUTER_MODELS;
  });

  it('skips the model when a no-model bot authored every commit', async () => {
    process.env.PR_AUTHOR = 'renovate[bot]';
    const commits = [
      { sha: 'b0b0000111122223', parents: ['a'], author: { login: 'renovate[bot]' }, commit: { message: 'chore(deps): bump x' } },
    ];
    const { github } = makeGithub(HEAD_SHA, commits);
    await run({ github, context, core });
    expect(core.failures).toHaveLength(0);
    expect(core.getOutput('skip')).toBe('true');
    expect(core.getOutput('model')).toBe('');
    expect(core.getOutput('family')).toBe('');
  });

  it('reviews a bot pull request that carries a commit by someone else', async () => {
    process.env.PR_AUTHOR = 'renovate[bot]';
    const commits = [
      { sha: 'b0b0000111122223', parents: ['a'], author: { login: 'renovate[bot]' }, commit: { message: 'chore(deps): bump x' } },
      { sha: 'b0b0000444455556', parents: ['b'], author: { login: 'someone' }, commit: { message: 'fix: y\n\nAssisted-by: Claude:claude-opus-5-5' } },
    ];
    const { github } = makeGithub(HEAD_SHA, commits);
    await run({ github, context, core });
    expect(core.getOutput('skip')).not.toBe('true');
    expect(core.failures).toHaveLength(1);
    expect(core.failures[0]).toContain('no Assisted-by trailer');
  });

  it('checks the head before skipping a bot pull request', async () => {
    process.env.PR_AUTHOR = 'renovate[bot]';
    const { github } = makeGithub('deadbeef0001111', []);
    await run({ github, context, core });
    expect(core.failures[0]).toContain('head moved');
    expect(core.getOutput('skip')).toBeUndefined();
  });

  it('picks medium for a Claude-authored commit', async () => {
    const commits = [
      {
        sha: 'aaa111122223333',
        parents: ['bbb222244445555'],
        commit: { message: 'fix: x\n\nAssisted-by: Claude:claude-opus-5-5' },
      },
    ];
    const { github, paginate } = makeGithub(HEAD_SHA, commits);
    await run({ github, context, core });
    expect(core.failures).toHaveLength(0);
    expect(core.getOutput('skip')).toBe('false');
    expect(core.getOutput('model')).toBe('medium');
    expect(core.getOutput('family')).toBe('qwen');
    expect(core.getOutput('author_families')).toBe('claude');
    expect(paginate).toHaveBeenCalledWith('listCommits', {
      owner: 'test-owner',
      repo: 'test-repo',
      pull_number: 42,
      per_page: 100,
    });
  });

  it('fails when the head moved since the run started', async () => {
    const commits = [
      {
        sha: 'aaa111122223333',
        parents: ['bbb222244445555'],
        commit: { message: 'fix: x\n\nAssisted-by: Claude:claude-opus-5-5' },
      },
    ];
    const { github, paginate } = makeGithub('deadbeef0001111', commits);
    await run({ github, context, core });
    expect(core.failures).toHaveLength(1);
    expect(core.failures[0]).toContain('head moved');
    expect(core.failures[0]).toContain('abc1234');
    expect(core.failures[0]).toContain('deadbee');
    expect(core.failures[0]).toContain('this run reviews nothing');
    expect(paginate).not.toHaveBeenCalled();
  });

  it('fails when a commit has no Assisted-by trailer', async () => {
    const commits = [
      {
        sha: 'aaa111122223333',
        parents: ['bbb222244445555'],
        commit: { message: 'fix: x' },
      },
    ];
    const { github } = makeGithub(HEAD_SHA, commits);
    await run({ github, context, core });
    expect(core.failures).toHaveLength(1);
    expect(core.failures[0]).toContain('no Assisted-by trailer');
    expect(core.failures[0]).toContain('aaa1111');
  });

  it('fails on an unknown model family in the trailer', async () => {
    const commits = [
      {
        sha: 'aaa111122223333',
        parents: ['bbb222244445555'],
        commit: { message: 'feat: y\n\nAssisted-by: Mystery:foo-1' },
      },
    ];
    const { github } = makeGithub(HEAD_SHA, commits);
    await run({ github, context, core });
    expect(core.failures).toHaveLength(1);
    expect(core.failures[0]).toContain('Unknown model family');
    expect(core.failures[0]).toContain('Mystery:foo-1');
  });

  it('fails when no reviewer of another family is served', async () => {
    const commits = [
      {
        sha: 'aaa111122223333',
        parents: ['bbb222244445555'],
        commit: { message: 'feat: z\n\nAssisted-by: Qwen Code:qwen4-max-preview' },
      },
    ];
    const { github } = makeGithub(HEAD_SHA, commits);
    await run({ github, context, core });
    expect(core.failures).toHaveLength(1);
    expect(core.failures[0]).toContain('No reviewer of another family is served');
    expect(core.failures[0]).toContain('qwen');
  });

  it('ignores merge commits and picks medium for a Claude commit', async () => {
    const commits = [
      {
        sha: 'c0ffee01aaaa1111',
        parents: ['aaa111122223333', 'bbb222244445555'],
        commit: { message: 'Merge branch main into feat' },
      },
      {
        sha: 'c0ffee02aaaa2222',
        parents: ['bbb222244445555'],
        commit: { message: 'feat: y\n\nAssisted-by: Claude:claude-sonnet-4' },
      },
    ];
    const { github } = makeGithub(HEAD_SHA, commits);
    await run({ github, context, core });
    expect(core.failures).toHaveLength(0);
    expect(core.getOutput('skip')).toBe('false');
    expect(core.getOutput('model')).toBe('medium');
    expect(core.getOutput('family')).toBe('qwen');
    expect(core.getOutput('author_families')).toBe('claude');
  });

  it('collects families across commits and still picks medium', async () => {
    const commits = [
      {
        sha: 'c0ffee03aaaa3333',
        parents: ['aaa111122223333'],
        commit: { message: 'fix: x\n\nAssisted-by: Claude:claude-opus-5-5' },
      },
      {
        sha: 'c0ffee04aaaa4444',
        parents: ['c0ffee03aaaa3333'],
        commit: { message: 'fix: y\n\nAssisted-by: ZCode:glm-5' },
      },
    ];
    const { github } = makeGithub(HEAD_SHA, commits);
    await run({ github, context, core });
    expect(core.failures).toHaveLength(0);
    expect(core.getOutput('skip')).toBe('false');
    expect(core.getOutput('model')).toBe('medium');
    expect(core.getOutput('family')).toBe('qwen');
    expect(core.getOutput('author_families')).toBe('claude,glm');
  });

  const claudeCommit = [
    { sha: 'c0ffee05aaaa5555', parents: ['a'], commit: { message: 'fix: x\n\nAssisted-by: Claude:claude-opus-5-5' } },
  ];

  it('picks the public alias for a public repository', async () => {
    process.env.VISIBILITY = 'public';
    const { github } = makeGithub(HEAD_SHA, claudeCommit);
    await run({ github, context, core });
    expect(core.failures).toHaveLength(0);
    expect(core.getOutput('model')).toBe('review-oss');
  });

  it('fails when the router does not serve any listed alias', async () => {
    process.env.ROUTER_MODELS = 'standard\n';
    const { github } = makeGithub(HEAD_SHA, claudeCommit);
    await run({ github, context, core });
    expect(core.failures).toHaveLength(1);
    expect(core.failures[0]).toContain('No reviewer of another family is served');
  });

  it('fails when any author family has no reviewer, as Qwen has none', async () => {
    const commits = [
      ...claudeCommit,
      { sha: 'c0ffee06aaaa6666', parents: ['b'], commit: { message: 'fix: y\n\nAssisted-by: Qwen Code:qwen4-max-preview' } },
    ];
    const { github } = makeGithub(HEAD_SHA, commits);
    await run({ github, context, core });
    expect(core.failures).toHaveLength(1);
    expect(core.failures[0]).toContain('claude,qwen');
  });

  it('fails on a visibility other than public or private', async () => {
    process.env.VISIBILITY = '';
    const { github, pullsGet } = makeGithub(HEAD_SHA, claudeCommit);
    await run({ github, context, core });
    expect(core.failures).toHaveLength(1);
    expect(pullsGet).not.toHaveBeenCalled();
  });
});
