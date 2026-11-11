const { mock, describe, it, expect, beforeEach } = require('bun:test');
const { createMockCore, createMockContext, createMockGithub } = require('./helpers.js');
const run = require('../.github/scripts/pr-reconcile/reconcile.js');

const { classify } = run;

function pr(overrides = {}) {
  return {
    number: 7,
    state: 'open',
    mergeable_state: 'clean',
    head: { ref: 'feat/x', sha: 'head1', repo: { full_name: 'test-owner/test-repo' } },
    base: { ref: 'develop', sha: 'base1', repo: { full_name: 'test-owner/test-repo' } },
    user: { login: 'someone' },
    labels: [],
    body: '',
    ...overrides,
  };
}

function github(prData, { statuses = [], files = [] } = {}) {
  const gh = createMockGithub();
  gh.rest.pulls.get.mockResolvedValue({ data: prData });
  gh.rest.pulls.updateBranch = mock().mockResolvedValue({});
  gh.rest.pulls.update = mock().mockResolvedValue({});
  gh.rest.pulls.listFiles = mock();
  gh.rest.issues.removeLabel = mock().mockResolvedValue({});
  gh.rest.issues.addLabels.mockResolvedValue({});
  gh.rest.repos.getCombinedStatusForRef = mock().mockResolvedValue({ data: { statuses } });
  gh.rest.repos.createCommitStatus = mock().mockResolvedValue({});
  gh.rest.repos.createDispatchEvent = mock().mockResolvedValue({});
  gh.rest.repos.getBranch = mock().mockResolvedValue({ data: { commit: { sha: 'base1' } } });
  gh.paginate.mockResolvedValue(files);
  return gh;
}

describe('classify', () => {
  it('updates a branch that is behind', () => {
    expect(classify(pr({ mergeable_state: 'behind' }))).toEqual({ state: 'behind', action: 'update-branch' });
  });
  it('labels a conflicted branch', () => {
    expect(classify(pr({ mergeable_state: 'dirty' })).action).toBe('label-conflict');
  });
  it('never updates a develop-to-main promotion and sends its conflict to the lead', () => {
    const promotion = { head: { ref: 'develop', sha: 's', repo: { full_name: 'test-owner/test-repo' } }, base: { ref: 'main', repo: { full_name: 'test-owner/test-repo' } } };
    expect(classify(pr({ ...promotion, mergeable_state: 'behind' })).action).toBe('none');
    expect(classify(pr({ ...promotion, mergeable_state: 'dirty' })).action).toBe('label-lead');
  });
  it('skips release-please branches and forks', () => {
    expect(classify(pr({ mergeable_state: 'dirty', head: { ref: 'release-please--branches--main', sha: 's', repo: { full_name: 'test-owner/test-repo' } } })).action).toBe('skip');
    expect(classify(pr({ mergeable_state: 'dirty', head: { ref: 'x', sha: 's', repo: { full_name: 'fork/test-repo' } } })).action).toBe('skip');
  });
  it('asks Renovate to rebase its own PR', () => {
    expect(classify(pr({ mergeable_state: 'dirty', user: { login: 'renovate[bot]' } })).action).toBe('renovate-rebase');
  });
  it('removes a stale conflict label once the PR is mergeable', () => {
    expect(classify(pr({ labels: [{ name: 'merge-conflict' }] })).action).toBe('unlabel-conflict');
  });
  it('reports mergeability-unknown and takes no action when the base is stale', () => {
    expect(classify(pr({ mergeable_state: 'clean' }), true)).toEqual({ state: 'mergeability-unknown', action: 'none' });
  });
});

describe('reconcile', () => {
  let core;
  beforeEach(() => {
    core = createMockCore();
    run.retryDelayMs = 0;
    run.retryBudgetMs = 3 * 60 * 1000;
    run.runBudgetMs = 4 * 60 * 1000;
    delete process.env.RESOLVER_REPO;
    delete process.env.BASE_REF;
    delete process.env.SWEEP_OWNER;
    delete process.env.PR_RECONCILE_FENCE;
    process.env.PR_NUMBER = '7';
  });

  it('calls update-branch at the observed head and records the action once', async () => {
    const gh = github(pr({ mergeable_state: 'behind' }));
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.pulls.updateBranch).toHaveBeenCalledWith({ owner: 'test-owner', repo: 'test-repo', pull_number: 7, expected_head_sha: 'head1' });
    expect(gh.rest.repos.createCommitStatus.mock.calls.map((c) => c[0])).toContainEqual(expect.objectContaining({ sha: 'head1', context: 'pr-reconcile', description: 'update-branch' }));
    expect(event).toMatchObject({ pr: 7, state: 'behind', action: 'update-branch', outcome: 'updated' });
  });

  it('does not repeat an action already recorded at the same head', async () => {
    const gh = github(pr({ mergeable_state: 'behind' }), { statuses: [{ context: 'pr-reconcile', description: 'update-branch' }] });
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.pulls.updateBranch).not.toHaveBeenCalled();
    expect(event.outcome).toBe('already-done');
  });

  it('labels a conflict and dispatches the resolver when one is configured', async () => {
    process.env.RESOLVER_REPO = 'ctl-owner/ctl-repo';
    const gh = github(pr({ mergeable_state: 'dirty' }), { files: [{ filename: 'src/a.js' }] });
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.issues.addLabels.mock.calls[0][0].labels).toEqual(['merge-conflict']);
    expect(gh.rest.repos.createDispatchEvent.mock.calls[0][0]).toMatchObject({ owner: 'ctl-owner', repo: 'ctl-repo', event_type: 'pr-conflict' });
    expect(event.outcome).toBe('labelled-dispatched');
  });

  it('sends a conflict that touches workflow files to the lead without dispatching', async () => {
    process.env.RESOLVER_REPO = 'ctl-owner/ctl-repo';
    const gh = github(pr({ mergeable_state: 'dirty' }), { files: [{ filename: '.github/workflows/ci.yml' }] });
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.issues.addLabels.mock.calls[0][0].labels).toEqual(['merge-conflict', 'needs-lead']);
    expect(gh.rest.repos.createDispatchEvent).not.toHaveBeenCalled();
    expect(event.outcome).toBe('labelled-lead-workflows');
  });

  it('retries while mergeability is unknown and acts once it resolves', async () => {
    const gh = github(pr());
    gh.rest.pulls.get
      .mockResolvedValueOnce({ data: pr({ mergeable_state: 'unknown' }) })
      .mockResolvedValueOnce({ data: pr({ mergeable_state: 'behind' }) });
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(event.action).toBe('update-branch');
  });

  it('logs one JSON event per pull request', async () => {
    const gh = github(pr());
    await run({ github: gh, context: createMockContext(), core });
    expect(JSON.parse(core.infos[0])).toMatchObject({ event: 'pr_reconcile', repository: 'test-owner/test-repo', pr: 7, action: 'none' });
  });

  it('reconciles every open PR on a base for push-to-base', async () => {
    delete process.env.PR_NUMBER;
    process.env.BASE_REF = 'develop';
    const gh = github(pr());
    gh.paginate.mockResolvedValueOnce([{ number: 7 }, { number: 8 }]);
    const events = await run({ github: gh, context: createMockContext(), core });
    expect(events.length).toBe(2);
  });

  it('records an API error as the outcome instead of throwing', async () => {
    const gh = github(pr({ mergeable_state: 'behind' }));
    gh.rest.pulls.updateBranch.mockRejectedValue(Object.assign(new Error('x'), { status: 422 }));
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(event.outcome).toBe('error:422');
    expect(gh.rest.repos.createCommitStatus.mock.calls.map((c) => c[0].context)).not.toContain('pr-reconcile');
  });

  it('sets merge-hold to failure on a held PR and keeps reconciling it', async () => {
    const gh = github(pr({ mergeable_state: 'behind', labels: [{ name: 'merge-hold' }] }));
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.repos.createCommitStatus.mock.calls[0][0]).toMatchObject({ context: 'merge-hold', state: 'failure', sha: 'head1' });
    expect(gh.rest.pulls.updateBranch).toHaveBeenCalled();
    expect(event).toMatchObject({ held: true, outcome: 'updated' });
  });

  it('sets merge-hold to success once, then leaves an unchanged status alone', async () => {
    const gh = github(pr(), { statuses: [{ context: 'merge-hold', state: 'success' }] });
    await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.repos.createCommitStatus).not.toHaveBeenCalled();
    const fresh = github(pr());
    await run({ github: fresh, context: createMockContext(), core });
    expect(fresh.rest.repos.createCommitStatus.mock.calls[0][0]).toMatchObject({ context: 'merge-hold', state: 'success' });
  });

  it('does not record a Renovate rebase when the PR has no rebase box', async () => {
    const gh = github(pr({ mergeable_state: 'dirty', user: { login: 'renovate[bot]' }, body: 'no box' }), { statuses: [{ context: 'merge-hold', state: 'success' }] });
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(event.outcome).toBe('no-rebase-box');
    expect(gh.rest.repos.createCommitStatus).not.toHaveBeenCalled();
  });

  it('reports still-unknown after the retries run out', async () => {
    const gh = github(pr({ mergeable_state: 'unknown' }));
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.pulls.get).toHaveBeenCalledTimes(3);
    expect(event.outcome).toBe('still-unknown');
  });

  it('removes needs-lead with the conflict label once the PR is mergeable', async () => {
    const gh = github(pr({ labels: [{ name: 'merge-conflict' }, { name: 'needs-lead' }] }));
    await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.issues.removeLabel.mock.calls.map((c) => c[0].name)).toEqual(['merge-conflict', 'needs-lead']);
  });

  it('keeps sweeping when one PR fails to read', async () => {
    delete process.env.PR_NUMBER;
    process.env.SWEEP_OWNER = 'test-owner';
    const gh = github(pr());
    gh.paginate.mockResolvedValueOnce([
      { number: 7, repository_url: 'https://api.github.com/repos/test-owner/a' },
      { number: 8, repository_url: 'https://api.github.com/repos/test-owner/b' },
    ]);
    gh.rest.pulls.get.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
    const events = await run({ github: gh, context: createMockContext(), core });
    expect(events.map((e) => e.outcome)).toEqual(['error:404', 'noop']);
    expect(gh.paginate.mock.calls[0][1].q).toBe('is:pr is:open archived:false user:test-owner');
  });

  it('refuses a sweep owner that is not a plain login', async () => {
    delete process.env.PR_NUMBER;
    process.env.SWEEP_OWNER = 'test-owner is:closed';
    await expect(run({ github: github(pr()), context: createMockContext(), core })).rejects.toThrow('invalid SWEEP_OWNER');
  });

  it('warns when a sweep reaches the search cap', async () => {
    delete process.env.PR_NUMBER;
    process.env.SWEEP_OWNER = 'test-owner';
    const gh = github(pr());
    gh.paginate.mockResolvedValueOnce(Array.from({ length: 1000 }, () => ({ number: 7, repository_url: 'https://api.github.com/repos/test-owner/a' })));
    await run({ github: gh, context: createMockContext(), core });
    expect(core.warnings.some((w) => w.includes('truncated at 1000'))).toBe(true);
  });

  it('stops unknown-state retries once the retry budget is spent', async () => {
    run.retryBudgetMs = -1;
    const gh = github(pr({ mergeable_state: 'unknown' }));
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.pulls.get).toHaveBeenCalledTimes(1);
    expect(event.outcome).toBe('still-unknown');
  });

  it('defers the rest of a sweep once the run budget is spent', async () => {
    run.runBudgetMs = -1;
    delete process.env.PR_NUMBER;
    process.env.SWEEP_OWNER = 'test-owner';
    const gh = github(pr());
    gh.paginate.mockResolvedValueOnce([
      { number: 7, repository_url: 'https://api.github.com/repos/test-owner/a' },
      { number: 8, repository_url: 'https://api.github.com/repos/test-owner/b' },
    ]);
    const events = await run({ github: gh, context: createMockContext(), core });
    expect(events).toEqual([]);
    expect(core.warnings.some((w) => w.includes('2 pull requests deferred'))).toBe(true);
  });

  it('sends the resolver the repository, PR, head and base', async () => {
    process.env.RESOLVER_REPO = 'ctl-owner/ctl-repo';
    const gh = github(pr({ mergeable_state: 'dirty' }), { files: [{ filename: 'src/a.js' }] });
    await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.repos.createDispatchEvent.mock.calls[0][0].client_payload).toEqual({
      repository: 'test-owner/test-repo', pr: 7, head_sha: 'head1', base: 'develop',
    });
  });

  it('ticks the Renovate rebase box when the PR has one', async () => {
    const gh = github(pr({ mergeable_state: 'dirty', user: { login: 'renovate[bot]' }, body: 'x\n- [ ] <!-- rebase-check -->' }));
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.pulls.update.mock.calls[0][0].body).toContain('- [x] <!-- rebase-check -->');
    expect(event.outcome).toBe('rebase-requested');
  });

  it('refuses a resolver that is not owner/repo', async () => {
    process.env.RESOLVER_REPO = 'ctl-owner/';
    await expect(run({ github: github(pr()), context: createMockContext(), core })).rejects.toThrow('invalid RESOLVER_REPO');
  });

  it('re-fetches a clean PR whose base.sha is stale, and labels the conflict found on retry', async () => {
    const gh = github(pr({ mergeable_state: 'clean', base: { ref: 'develop', sha: 'old', repo: { full_name: 'test-owner/test-repo' } } }));
    gh.rest.pulls.get
      .mockResolvedValueOnce({ data: pr({ mergeable_state: 'clean', base: { ref: 'develop', sha: 'old', repo: { full_name: 'test-owner/test-repo' } } }) })
      .mockResolvedValueOnce({ data: pr({ mergeable_state: 'dirty' }) });
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.pulls.get).toHaveBeenCalledTimes(2);
    expect(gh.rest.issues.addLabels.mock.calls[0][0].labels).toEqual(['merge-conflict']);
    expect(event).toMatchObject({ state: 'dirty', action: 'label-conflict', outcome: 'labelled' });
  });

  it('matches fence entries case-insensitively and treats a trailing * as a prefix', () => {
    process.env.PR_RECONCILE_FENCE = 'Fence-Owner, fence-prefix-*, fence-repo';
    expect(run.fenced('FENCE-owner')).toBe(true);
    expect(run.fenced('fence-prefix-a')).toBe(true);
    expect(run.fenced('fence-owner-2')).toBe(false);
    expect(run.fenced('Fence-Repo')).toBe(true);
    expect(run.fenced('other-repo')).toBe(false);
  });

  it('treats a blank fence list as empty and trims entries', () => {
    process.env.PR_RECONCILE_FENCE = '   ';
    expect(run.fenceEntries()).toEqual([]);
    process.env.PR_RECONCILE_FENCE = ' , , ';
    expect(run.fenceEntries()).toEqual([]);
    process.env.PR_RECONCILE_FENCE = ' Fence-Repo , fence-prefix-* ,, ';
    expect(run.fenceEntries()).toEqual(['fence-repo', 'fence-prefix-*']);
  });

  it('refuses a resolver whose repository is fenced, before any dispatch or label', async () => {
    process.env.PR_NUMBER = '7';
    process.env.RESOLVER_REPO = 'ctl-owner/fence-repo';
    process.env.PR_RECONCILE_FENCE = 'fence-repo';
    const gh = github(pr({ mergeable_state: 'dirty' }), { files: [{ filename: 'src/a.js' }] });
    await expect(run({ github: gh, context: createMockContext(), core })).rejects.toThrow('resolver repository is fenced');
    expect(gh.rest.repos.createDispatchEvent).not.toHaveBeenCalled();
    expect(gh.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(gh.rest.pulls.get).not.toHaveBeenCalled();
  });

  it('refuses a resolver whose owner is fenced, before any dispatch', async () => {
    process.env.RESOLVER_REPO = 'fence-owner/ctl-repo';
    process.env.PR_RECONCILE_FENCE = 'fence-owner';
    const gh = github(pr({ mergeable_state: 'dirty' }), { files: [{ filename: 'src/a.js' }] });
    await expect(run({ github: gh, context: createMockContext(), core })).rejects.toThrow('resolver repository is fenced');
    expect(gh.rest.repos.createDispatchEvent).not.toHaveBeenCalled();
  });

  it('fails a sweep of a fenced owner before any request', async () => {
    delete process.env.PR_NUMBER;
    process.env.SWEEP_OWNER = 'fence-owner';
    process.env.PR_RECONCILE_FENCE = 'fence-owner,fence-repo';
    const gh = github(pr());
    await expect(run({ github: gh, context: createMockContext(), core })).rejects.toThrow('owner is fenced');
    expect(gh.paginate).not.toHaveBeenCalled();
    expect(gh.rest.pulls.get).not.toHaveBeenCalled();
  });

  it('fails a sweep whose search returns a fenced repository, with no write to any pull request', async () => {
    delete process.env.PR_NUMBER;
    process.env.SWEEP_OWNER = 'test-owner';
    process.env.PR_RECONCILE_FENCE = 'fence-owner,fence-repo';
    const gh = github(pr({ mergeable_state: 'behind' }));
    gh.paginate.mockResolvedValueOnce([
      { number: 7, repository_url: 'https://api.github.com/repos/test-owner/test-repo' },
      { number: 8, repository_url: 'https://api.github.com/repos/test-owner/fence-repo' },
    ]);
    await expect(run({ github: gh, context: createMockContext(), core })).rejects.toThrow('fenced repository');
    expect(gh.rest.pulls.get).not.toHaveBeenCalled();
    expect(gh.rest.pulls.updateBranch).not.toHaveBeenCalled();
    expect(gh.rest.repos.createCommitStatus).not.toHaveBeenCalled();
  });

  it('gives mergeability-unknown and no write when the base is still stale at the end of the budget', async () => {
    const gh = github(pr({ mergeable_state: 'clean', base: { ref: 'develop', sha: 'old', repo: { full_name: 'test-owner/test-repo' } } }));
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.pulls.get).toHaveBeenCalledTimes(3);
    expect(event).toMatchObject({ state: 'mergeability-unknown', action: 'none', outcome: 'noop' });
    expect(gh.rest.pulls.updateBranch).not.toHaveBeenCalled();
    expect(gh.rest.pulls.update).not.toHaveBeenCalled();
    expect(gh.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(gh.rest.issues.removeLabel).not.toHaveBeenCalled();
    expect(gh.rest.repos.createDispatchEvent).not.toHaveBeenCalled();
    expect(gh.rest.repos.createCommitStatus.mock.calls.map((c) => c[0].context)).toEqual(['merge-hold']);
  });

  it('skips the base check for release-please branches', async () => {
    const gh = github(pr({ mergeable_state: 'dirty', base: { ref: 'develop', sha: 'old', repo: { full_name: 'test-owner/test-repo' } }, head: { ref: 'release-please--branches--develop', sha: 'head1', repo: { full_name: 'test-owner/test-repo' } } }));
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.repos.getBranch).not.toHaveBeenCalled();
    expect(event).toMatchObject({ state: 'dirty', action: 'skip' });
  });
});
