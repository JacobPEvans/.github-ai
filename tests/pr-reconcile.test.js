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
    base: { ref: 'develop', repo: { full_name: 'test-owner/test-repo' } },
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
});

describe('reconcile', () => {
  let core;
  beforeEach(() => {
    core = createMockCore();
    run.retryDelayMs = 0;
    delete process.env.RESOLVER_REPO;
    delete process.env.BASE_REF;
    delete process.env.SWEEP_OWNER;
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
});
