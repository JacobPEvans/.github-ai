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

// A develop-to-main promotion on a git-flow repository, carrying the release label the sweep looks for.
const promotion = (overrides = {}) => pr({
  title: 'chore(develop): promotion',
  head: { ref: 'develop', sha: 'head1', repo: { full_name: 'test-owner/test-repo' } },
  base: { ref: 'main', repo: { full_name: 'test-owner/test-repo', default_branch: 'develop' } },
  labels: [{ name: 'release:in-progress' }],
  ...overrides,
});

const releaseCommits = (version) => [{ commit: { message: `chore(develop): release ${version}`, committer: { date: '2026-11-20T00:00:00Z' } } }];

function github(prData, { checks = [green('lint'), green('AI Merge Gate / AI Merge Gate')], statuses = [], live = {}, promotions = [], commits = [], comments = [] } = {}) {
  const gh = createMockGithub();
  gh.rest.pulls.get.mockResolvedValue({ data: prData });
  gh.rest.pulls.merge = mock().mockResolvedValue({});
  gh.rest.pulls.listCommits = mock();
  gh.rest.issues.createComment = mock().mockResolvedValue({});
  gh.rest.repos.getCombinedStatusForRef = mock().mockResolvedValue({ data: { statuses } });
  gh.rest.repos.createCommitStatus = mock().mockResolvedValue({});
  gh.paginate.mockImplementation(async (fn) => (fn === gh.rest.pulls.listCommits ? commits
    : fn === gh.rest.issues.listComments ? comments
    : fn === gh.rest.pulls.list ? promotions
    : checks));
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
    ['label:needs-lead', pr({ labels: [{ name: 'needs-lead' }] }), {}],
    ['held', pr({ labels: [{ name: 'merge-hold' }] }), {}],
    ['zcode-branch', pr({ head: { ref: 'agent/zcode/j-1', sha: 'head1', repo: { full_name: 'test-owner/test-repo' } } }), {}],
    ['promotion', promotion({ labels: [] }), {}],
    ['state:blocked', pr({ mergeable_state: 'blocked' }), {}],
    ['head-moved', pr(), { live: { headRefOid: 'head2' } }],
    ['changes-requested', pr(), { live: { reviewDecision: 'CHANGES_REQUESTED' } }],
    ['unresolved-threads', pr(), { live: { reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] } } }],
    ['checks-pending', pr(), { checks: [{ ...green('lint'), status: 'in_progress', conclusion: null }] }],
    ['check:Code review', pr(), { checks: [green('AI Merge Gate'), { ...green('Code review'), conclusion: 'failure' }] }],
    ['check:lint', pr(), { checks: [green('AI Merge Gate'), { ...green('lint'), conclusion: 'cancelled' }] }],
    ['status:ext-ci', pr(), { statuses: [{ context: 'ext-ci', state: 'pending' }] }],
    ['no-gate-success', pr(), { checks: [green('lint')] }],
    ['no-gate-success', pr(), { checks: [green('lint'), green('Merge Gate')] }],
    ['no-gate-success', pr({ user: { login: 'renovate[bot]', type: 'Bot' } }), { checks: [green('lint')] }],
    ['no-gate-success', pr({ user: { login: 'renovate[bot]', type: 'Bot' } }),
      { checks: [green('lint'), { ...green('AI Merge Gate'), conclusion: 'neutral' }, green('Merge Gate')] }],
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

  it('passes a Renovate, release-please or promotion pull request on the repository Merge Gate when no AI gate ran', async () => {
    const repoGate = { checks: [green('lint'), green('CI / Merge Gate')], commits: releaseCommits('2.29.0') };
    const renovate = github(pr({ user: { login: 'renovate[bot]', type: 'Bot' } }), repoGate);
    expect((await reconcileOne(renovate)).merge.outcome).toBe('merged');
    const head = { ref: 'release-please--branches--main', sha: 'head1', repo: { full_name: 'test-owner/test-repo' } };
    const release = github(pr({ head, title: 'chore(main): release 2.17.0' }), repoGate);
    expect((await reconcileOne(release)).merge.outcome).toBe('merged');
    const promoted = github(promotion(), repoGate);
    expect((await reconcileOne(promoted)).merge.outcome).toBe('merged');
    expect(promoted.rest.pulls.merge.mock.calls[0][0].merge_method).toBe('merge');
  });

  it('treats a renovate/ branch from another App as Renovate, but a major update still needs the AI gate', async () => {
    const repoGate = { checks: [green('lint'), green('CI / Merge Gate')] };
    const branch = (ref) => ({ ref, sha: 'head1', repo: { full_name: 'test-owner/test-repo' } });
    const otherApp = github(pr({ user: { login: 'release-app[bot]', type: 'Bot' }, head: branch('renovate/first-party') }), repoGate);
    expect((await reconcileOne(otherApp)).merge.outcome).toBe('merged');
    const majors = [
      pr({ head: branch('renovate/foo-2.x'), labels: [{ name: 'update:major' }] }),
      pr({ head: branch('renovate/major-all') }),
      pr({ head: branch('renovate/foo-2.x'), body: '| Package | Type | Update | Change |\n|---|---|---|---|\n| foo | action | major | `v1` -> `v2` |' }),
    ];
    for (const major of majors) {
      expect((await reconcileOne(github(major, repoGate))).merge.reason).toBe('no-gate-success');
    }
  });

  it('judges only the newest run of each check name', async () => {
    const gate = { ...green('AI Merge Gate'), id: 1 };
    const rerunGreen = github(pr(), { checks: [gate, { ...green('lint'), id: 2, conclusion: 'failure' }, { ...green('lint'), id: 3 }] });
    expect((await reconcileOne(rerunGreen)).merge.outcome).toBe('merged');
    const rerunRed = github(pr(), { checks: [gate, { ...green('lint'), id: 3, conclusion: 'failure' }, { ...green('lint'), id: 2 }] });
    expect((await reconcileOne(rerunRed)).merge.reason).toBe('check:lint');
  });

  it('merges a green labelled promotion with a merge commit and never touches its labels', async () => {
    const gh = github(promotion(), { commits: releaseCommits('2.29.0') });
    const event = await reconcileOne(gh);
    expect(gh.rest.pulls.merge).toHaveBeenCalledTimes(1);
    expect(gh.rest.pulls.merge).toHaveBeenCalledWith({ owner: 'test-owner', repo: 'test-repo', pull_number: 7, sha: 'head1', merge_method: 'merge' });
    expect(event.merge).toEqual({ outcome: 'merged', reason: '', disarmed: false });
    expect(gh.rest.issues.createComment).not.toHaveBeenCalled();
    expect(gh.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it('holds a labelled promotion while any check is red, pending, or missing', async () => {
    for (const [reason, options] of [
      ['check:lint', { checks: [green('AI Merge Gate / AI Merge Gate'), { ...green('lint'), conclusion: 'failure' }] }],
      ['checks-pending', { checks: [{ ...green('AI Merge Gate / AI Merge Gate'), status: 'in_progress', conclusion: null }] }],
      ['no-checks', { checks: [] }],
    ]) {
      const gh = github(promotion(), { commits: releaseCommits('2.29.0'), ...options });
      const event = await reconcileOne(gh);
      expect(gh.rest.pulls.merge).not.toHaveBeenCalled();
      expect(gh.rest.issues.createComment).not.toHaveBeenCalled();
      expect(event.merge).toMatchObject({ outcome: 'merge-skip', reason });
    }
  });

  it('skips a labelled promotion whose head moved after the read', async () => {
    const gh = github(promotion(), { commits: releaseCommits('2.29.0'), live: { headRefOid: 'head2' } });
    const event = await reconcileOne(gh);
    expect(gh.rest.pulls.merge).not.toHaveBeenCalled();
    expect(gh.rest.issues.createComment).not.toHaveBeenCalled();
    expect(event.merge).toMatchObject({ outcome: 'merge-skip', reason: 'head-moved' });
  });

  it('skips a major promotion with one human-merge note, posted at most once', async () => {
    const commits = [
      { commit: { message: 'feat: more work', committer: { date: '2026-11-19T00:00:00Z' } } },
      { commit: { message: 'chore(develop): release 3.0.0', committer: { date: '2026-11-20T00:00:00Z' } } },
    ];
    const gh = github(promotion(), { commits });
    const event = await reconcileOne(gh);
    expect(gh.rest.pulls.merge).not.toHaveBeenCalled();
    expect(event.merge).toMatchObject({ outcome: 'merge-skip', reason: 'major-release' });
    expect(gh.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(gh.rest.issues.createComment.mock.calls[0][0].body).toContain('<!-- pr-reconcile:major-promotion -->');
    expect(gh.rest.issues.addLabels).not.toHaveBeenCalled();

    const again = github(promotion(), { commits, comments: [{ body: 'noted\n\n<!-- pr-reconcile:major-promotion -->' }] });
    await reconcileOne(again);
    expect(again.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('holds a promotion when any release it carries is major, not only the newest', async () => {
    const commits = [
      { commit: { message: 'chore(develop): release 3.0.0', committer: { date: '2026-11-19T00:00:00Z' } } },
      { commit: { message: 'chore(develop): release 3.1.0', committer: { date: '2026-11-20T00:00:00Z' } } },
    ];
    const gh = github(promotion(), { commits });
    const event = await reconcileOne(gh);
    expect(gh.rest.pulls.merge).not.toHaveBeenCalled();
    expect(event.merge).toMatchObject({ outcome: 'merge-skip', reason: 'major-release' });
  });

  it('merges a promotion whose releases are all minor or patch', async () => {
    const commits = [
      { commit: { message: 'chore(develop): release 2.28.1', committer: { date: '2026-11-19T00:00:00Z' } } },
      { commit: { message: 'chore(develop): release 2.29.0', committer: { date: '2026-11-20T00:00:00Z' } } },
    ];
    const gh = github(promotion(), { commits });
    const event = await reconcileOne(gh);
    expect(event.merge.outcome).toBe('merged');
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
