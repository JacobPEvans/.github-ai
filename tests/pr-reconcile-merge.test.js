const { mock, describe, it, expect, beforeEach, afterEach } = require('bun:test');
const { createMockCore, createMockContext, createMockGithub } = require('./helpers.js');
const run = require('../.github/scripts/pr-reconcile/reconcile.js');
const { majorRelease } = require('../.github/scripts/pr-reconcile/merge.js');

function pr(overrides = {}) {
  return {
    number: 7,
    state: 'open',
    draft: false,
    mergeable_state: 'clean',
    title: 'fix: something',
    head: { ref: 'fix/x', sha: 'head1', repo: { full_name: 'test-owner/test-repo' } },
    base: { ref: 'main', repo: { full_name: 'test-owner/test-repo', default_branch: 'main' } },
    user: { login: 'agent-app[bot]', type: 'Bot' },
    labels: [],
    body: '',
    ...overrides,
  };
}

const green = (name) => ({ name, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } });

function github(prData, { checks = [green('lint'), green('AI Merge Gate / AI Merge Gate')], statuses = [], live = {}, promotions = [] } = {}) {
  const gh = createMockGithub();
  gh.rest.pulls.get.mockResolvedValue({ data: prData });
  gh.rest.pulls.merge = mock().mockResolvedValue({});
  gh.rest.repos.getCombinedStatusForRef = mock().mockResolvedValue({ data: { statuses } });
  gh.rest.repos.createCommitStatus = mock().mockResolvedValue({});
  gh.paginate.mockImplementation(async (fn) => (fn === gh.rest.pulls.list ? promotions : checks));
  gh.graphql = mock(async (query) => (query.startsWith('mutation') ? {} : {
    repository: {
      pullRequest: {
        id: 'PR_1', headRefOid: 'head1', reviewDecision: null, autoMergeRequest: null,
        reviewThreads: { nodes: [] }, ...live,
      },
    },
  }));
  return gh;
}

describe('sweep merge', () => {
  let core;
  beforeEach(() => {
    core = createMockCore();
    core.summary = { addRaw: mock(function addRaw() { return this; }), write: mock().mockResolvedValue() };
    run.retryDelayMs = 0;
    for (const name of ['CI_FIX_WORKFLOW', 'CI_FIX_SKIP_CHECKS', 'RESOLVER_REPO', 'PR_RECONCILE_EXCLUDE_REPOS']) delete process.env[name];
    delete process.env.SWEEP_OWNER;
    delete process.env.BASE_REF;
    process.env.PR_NUMBER = '7';
    process.env.MERGE_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.MERGE_ENABLED;
  });

  const reconcileOne = async (gh) => (await run({ github: gh, context: createMockContext(), core }))[0];

  it('squash-merges a green bot pull request at its exact head and writes the summary', async () => {
    const gh = github(pr());
    const event = await reconcileOne(gh);
    expect(gh.rest.pulls.merge).toHaveBeenCalledWith({ owner: 'test-owner', repo: 'test-repo', pull_number: 7, sha: 'head1', merge_method: 'squash' });
    expect(event.merge).toEqual({ outcome: 'merged', reason: '', disarmed: false });
    expect(core.summary.addRaw.mock.calls[0][0]).toContain('| test-owner/test-repo#7 | merged | - | no |');
  });

  it('uses a merge commit into main on a git-flow repository', async () => {
    const gh = github(pr({ head: { ref: 'hotfix/x', sha: 'head1', repo: { full_name: 'test-owner/test-repo' } }, base: { ref: 'main', repo: { full_name: 'test-owner/test-repo', default_branch: 'develop' } } }));
    await reconcileOne(gh);
    expect(gh.rest.pulls.merge.mock.calls[0][0].merge_method).toBe('merge');
  });

  it('does nothing while MERGE_ENABLED is off', async () => {
    delete process.env.MERGE_ENABLED;
    const gh = github(pr());
    const event = await reconcileOne(gh);
    expect(gh.rest.pulls.merge).not.toHaveBeenCalled();
    expect(event.merge).toBeUndefined();
    expect(core.summary.addRaw).not.toHaveBeenCalled();
  });

  const skips = [
    ['not-bot', pr({ user: { login: 'someone', type: 'User' } }), {}],
    ['draft', pr({ draft: true }), {}],
    ['label:human:review', pr({ labels: [{ name: 'human:review' }] }), {}],
    ['held', pr({ labels: [{ name: 'merge-hold' }] }), {}],
    ['zcode-branch', pr({ head: { ref: 'agent/zcode/j-1', sha: 'head1', repo: { full_name: 'test-owner/test-repo' } } }), {}],
    ['state:blocked', pr({ mergeable_state: 'blocked' }), {}],
    ['head-moved', pr(), { live: { headRefOid: 'head2' } }],
    ['changes-requested', pr(), { live: { reviewDecision: 'CHANGES_REQUESTED' } }],
    ['unresolved-threads', pr(), { live: { reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] } } }],
    ['checks-pending', pr(), { checks: [{ ...green('lint'), status: 'in_progress', conclusion: null }] }],
    ['check:Code review', pr(), { checks: [green('AI Merge Gate'), { ...green('Code review'), conclusion: 'failure' }] }],
    ['check:lint', pr(), { checks: [green('AI Merge Gate'), { ...green('lint'), conclusion: 'cancelled' }] }],
    ['status:ext-ci', pr(), { statuses: [{ context: 'ext-ci', state: 'pending' }] }],
    ['no-gate-success', pr(), { checks: [green('lint')] }],
    ['no-checks', pr(), { checks: [] }],
  ];
  for (const [reason, data, options] of skips) {
    it(`skips with reason ${reason}`, async () => {
      const gh = github(data, options);
      const event = await reconcileOne(gh);
      expect(gh.rest.pulls.merge).not.toHaveBeenCalled();
      expect(event.merge).toMatchObject({ outcome: 'merge-skip', reason });
    });
  }

  it('skips a pull request into develop while the promotion is in release freeze, re-read before the merge', async () => {
    const develop = pr({ base: { ref: 'develop', repo: { full_name: 'test-owner/test-repo', default_branch: 'develop' } } });
    const gh = github(develop, { promotions: [{ number: 9, labels: [{ name: 'release:in-progress' }] }] });
    const event = await reconcileOne(gh);
    expect(gh.paginate.mock.calls.some(([fn, args]) => fn === gh.rest.pulls.list && args.base === 'main' && args.head === 'test-owner:develop')).toBe(true);
    expect(event.merge.reason).toBe('release-freeze');
    expect(gh.rest.pulls.merge).not.toHaveBeenCalled();
  });

  it('merges a release-please pull request during the freeze but never a major release', async () => {
    const head = { ref: 'release-please--branches--develop', sha: 'head1', repo: { full_name: 'test-owner/test-repo' } };
    const base = { ref: 'develop', repo: { full_name: 'test-owner/test-repo', default_branch: 'develop' } };
    const minor = github(pr({ head, base, title: 'chore(develop): release 2.17.0' }), { promotions: [{ labels: [{ name: 'release:in-progress' }] }] });
    expect((await reconcileOne(minor)).merge.outcome).toBe('merged');
    const major = github(pr({ head, base, title: 'chore(develop): release 3.0.0' }));
    expect((await reconcileOne(major)).merge.reason).toBe('major-release');
  });

  it('detects a major release in the title or a changelog heading only', () => {
    const head = { ref: 'release-please--branches--main' };
    expect(majorRelease({ head, title: 'chore: release main', body: '## [1.0.0](https://example.com) (2026-11-20)' })).toBe(true);
    expect(majorRelease({ head, title: 'chore(main): release v4.0.0', body: '' })).toBe(true);
    expect(majorRelease({ head, title: 'chore(main): release 2.10.0', body: '* bump dep to 5.0.0' })).toBe(false);
    expect(majorRelease({ head: { ref: 'fix/x' }, title: 'release 3.0.0', body: '' })).toBe(false);
  });

  it('disarms auto-merge on an agent pull request even when it skips the merge', async () => {
    const gh = github(pr({ draft: true }), { live: { autoMergeRequest: { enabledAt: '2026-11-20T00:00:00Z' } } });
    const event = await reconcileOne(gh);
    expect(gh.graphql.mock.calls.some(([query, vars]) => query.includes('disablePullRequestAutoMerge') && vars.id === 'PR_1')).toBe(true);
    expect(event.merge).toMatchObject({ outcome: 'merge-skip', reason: 'draft', disarmed: true });
  });

  it('leaves auto-merge armed on a release-please pull request', async () => {
    const head = { ref: 'release-please--branches--main', sha: 'head1', repo: { full_name: 'test-owner/test-repo' } };
    const gh = github(pr({ head, title: 'chore(main): release 2.17.0' }), { live: { autoMergeRequest: { enabledAt: 'x' } } });
    await reconcileOne(gh);
    expect(gh.graphql.mock.calls.some(([query]) => query.includes('disablePullRequestAutoMerge'))).toBe(false);
  });

  it('reports a failed merge call without throwing', async () => {
    const gh = github(pr());
    gh.rest.pulls.merge.mockRejectedValue(Object.assign(new Error('head moved'), { status: 409 }));
    const event = await reconcileOne(gh);
    expect(event.merge).toMatchObject({ outcome: 'merge-error:409', reason: 'api' });
  });
});
