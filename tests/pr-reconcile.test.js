const { mock, describe, it, expect, beforeEach } = require('bun:test');
const { readFileSync } = require('node:fs');
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

function checkRun(overrides = {}) {
  return {
    name: 'ci-unit',
    status: 'completed',
    conclusion: 'failure',
    app: { slug: 'github-actions' },
    details_url: 'https://github.com/test-owner/test-repo/actions/runs/424242',
    html_url: 'https://github.com/test-owner/test-repo/actions/runs/424242',
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
  gh.rest.actions.createWorkflowDispatch = mock().mockResolvedValue({});
  gh.rest.actions.reRunWorkflowFailedJobs = mock().mockResolvedValue({});
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
    run.retryBudgetMs = 3 * 60 * 1000;
    run.runBudgetMs = 4 * 60 * 1000;
    delete process.env.RESOLVER_REPO;
    delete process.env.PR_RECONCILE_EXCLUDE_REPOS;
    delete process.env.CI_FIX_WORKFLOW;
    delete process.env.CI_FIX_SKIP_CHECKS;
    delete process.env.BASE_REF;
    delete process.env.SWEEP_OWNER;
    process.env.PR_NUMBER = '7';
  });

  it('passes the exclusion secret only to the reconcile step', () => {
    const workflow = readFileSync('.github/workflows/pr-reconcile.yml', 'utf8');
    const sweep = readFileSync('.github/workflows/pr-reconcile-sweep.yml', 'utf8');
    const action = readFileSync('.github/actions/pr-reconcile-run/action.yml', 'utf8');
    const line = '          exclude_repos: ${{ secrets.PR_RECONCILE_EXCLUDE_REPOS }}';

    expect(workflow).toContain('      PR_RECONCILE_EXCLUDE_REPOS:\n        required: false');
    expect(workflow.split(line).length - 1).toBe(1);
    expect(workflow.indexOf(line)).toBeGreaterThan(workflow.indexOf('      - name: Reconcile'));
    const sweepLine = '          PR_RECONCILE_EXCLUDE_REPOS: ${{ secrets.PR_RECONCILE_EXCLUDE_REPOS }}';
    expect(sweep.split(sweepLine).length - 1).toBe(1);
    expect(sweep.indexOf(sweepLine)).toBeGreaterThan(sweep.indexOf('      - name: Reconcile'));
    expect(action.match(/PR_RECONCILE_EXCLUDE_REPOS:/g)).toEqual(['PR_RECONCILE_EXCLUDE_REPOS:']);
  });

  it('runs the sweep on review runners with an OIDC-minted owner token and no stored App key', () => {
    const sweep = readFileSync('.github/workflows/pr-reconcile-sweep.yml', 'utf8');

    expect(sweep).toContain('\npermissions:\n  contents: read\n  id-token: write\n\njobs:');
    expect(sweep).toContain('    runs-on: ubuntu-24.04\n    permissions: {}\n');
    expect(sweep).toContain('    runs-on: review\n');
    expect(sweep).not.toContain('group: pr-reconcile\n');
    expect(sweep).toContain('    permissions:\n      contents: read\n      id-token: write\n');
    expect(sweep).toContain('      fail-fast: false\n');
    expect(sweep).toContain('          role: pr-reconcile-sweep\n');
    expect(sweep).toContain('/v1/github/token`');
    expect(sweep).toContain("const permissions = { actions: 'write', checks: 'read', contents: 'write', pull_requests: 'write', statuses: 'write' };");
    expect(sweep).toContain('core.setSecret(token);');
    expect(sweep).toContain('github: getOctokit(token)');
    expect(sweep).not.toContain('steps.mint');
    expect(sweep).not.toContain('token=$token');
    expect(sweep).not.toContain('GH_APP_CLAUDE_BOT_PRIVATE_KEY');
    expect(sweep).not.toContain('pr-reconcile.yml');
    expect(sweep).not.toContain('repository:');
  });

  it('mints the calling repository token through the store when the caller grants OIDC, else the App key', () => {
    const text = readFileSync('.github/workflows/pr-reconcile.yml', 'utf8');
    const sweep = readFileSync('.github/workflows/pr-reconcile-sweep.yml', 'utf8');
    const workflow = Bun.YAML.parse(text);
    const call = workflow.on.workflow_call;
    const steps = workflow.jobs.reconcile.steps;
    const step = (name) => steps.find((s) => s.name === name);
    const permissions = "const permissions = { contents: 'write', pull_requests: 'write', statuses: 'write' };";
    const example = readFileSync('examples/pr-reconcile-caller.yml', 'utf8');

    expect(call.secrets.GH_APP_CLAUDE_BOT_PRIVATE_KEY.required).toBe(false);
    expect(call.secrets.OPENBAO_ADDR.required).toBe(false);
    expect(call.inputs.runner_label.default).toBe('ubuntu-24.04');
    // Only the review pool or the hosted runner: a caller cannot name an arbitrary runner label.
    expect(workflow.jobs.reconcile['runs-on']).toBe("${{ inputs.runner_label == 'review' && 'review' || 'ubuntu-24.04' }}");
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(step('Find the OpenBao address').run).toContain('[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] && [ -z "$SWEEP_OWNER" ]');
    expect(step('Log in to OpenBao').with).toMatchObject({ role: 'pr-reconcile', jwtGithubAudience: 'openbao', outputToken: true });
    expect(step('Mint repository token').with.script).toContain(permissions);
    // Single-repository reconcile never dispatches or reruns workflows, so it gets no actions or checks scope.
    expect(step('Mint repository token').with.script).not.toMatch(/actions:|checks:|issues:|workflows:/);
    expect(example).toContain('uses: JacobPEvans/.github-ai/.github/workflows/pr-reconcile.yml@v2\n');
    expect(step('Mint repository token').with.script).toContain('org_name: context.repo.owner, repositories, permissions');
    expect(step('Mint repository token').with.script).toContain('core.setSecret(token);');
    for (const name of ['Log in to OpenBao', 'Mint repository token']) expect(step(name).if).toBe("steps.bao.outputs.addr != ''");
    expect(step('Mint App token').if).toBe("steps.bao.outputs.addr == ''");
    expect(step('Reconcile').with['github-token']).toBe('${{ steps.bao-token.outputs.token || steps.app-token.outputs.token }}');
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

  it('skips excluded repositories during a sweep without logging their names', async () => {
    delete process.env.PR_NUMBER;
    process.env.SWEEP_OWNER = 'example-org';
    process.env.PR_RECONCILE_EXCLUDE_REPOS = ' EXAMPLE-ORG / HIDDEN-REPO ,  ';
    const gh = github(pr({ mergeable_state: 'behind' }));
    gh.paginate.mockResolvedValueOnce([
      { number: 7, repository_url: 'https://api.github.com/repos/example-org/hidden-repo' },
      { number: 8, repository_url: 'https://api.github.com/repos/example-org/public-repo' },
    ]);

    const events = await run({ github: gh, context: createMockContext(), core });
    const apiCalls = [
      ...gh.rest.pulls.get.mock.calls,
      ...gh.rest.pulls.updateBranch.mock.calls,
      ...gh.rest.pulls.update.mock.calls,
      ...gh.rest.pulls.listFiles.mock.calls,
      ...gh.rest.issues.addLabels.mock.calls,
      ...gh.rest.issues.removeLabel.mock.calls,
      ...gh.rest.repos.getCombinedStatusForRef.mock.calls,
      ...gh.rest.repos.createCommitStatus.mock.calls,
      ...gh.rest.repos.createDispatchEvent.mock.calls,
    ];
    const logs = JSON.stringify({ infos: core.infos, warnings: core.warnings, events, output: core.getOutput('events') });

    expect(gh.rest.pulls.get).toHaveBeenCalledTimes(1);
    expect(gh.rest.pulls.get.mock.calls[0][0]).toMatchObject({ owner: 'example-org', repo: 'public-repo', pull_number: 8 });
    expect(apiCalls.every(([args]) => args.owner !== 'example-org' || args.repo !== 'hidden-repo')).toBe(true);
    expect(gh.paginate.mock.calls.map(([method]) => method)).toEqual([gh.rest.search.issuesAndPullRequests]);
    expect(events).toHaveLength(1);
    expect(logs).not.toContain('example-org/hidden-repo');
    expect(core.infos).toContain('skipped 1 pull requests in excluded repositories');
  });

  it('skips excluded repositories in base mode before reading individual PRs', async () => {
    delete process.env.PR_NUMBER;
    process.env.BASE_REF = 'develop';
    process.env.PR_RECONCILE_EXCLUDE_REPOS = 'test-owner/test-repo';
    const gh = github(pr());
    gh.paginate.mockResolvedValueOnce([{ number: 7 }, { number: 8 }]);

    const events = await run({ github: gh, context: createMockContext(), core });

    expect(events).toEqual([]);
    expect(gh.paginate).not.toHaveBeenCalled();
    expect(gh.rest.pulls.get).not.toHaveBeenCalled();
    expect(gh.rest.repos.getCombinedStatusForRef).not.toHaveBeenCalled();
    expect(gh.rest.repos.createCommitStatus).not.toHaveBeenCalled();
    expect(JSON.stringify({ infos: core.infos, warnings: core.warnings, output: core.getOutput('events') })).not.toContain('test-owner/test-repo');
    expect(core.infos).toContain('skipped 1 reconcile target in excluded repositories');
  });

  it('skips an excluded single PR before any per-PR API calls', async () => {
    process.env.PR_RECONCILE_EXCLUDE_REPOS = ' TEST-OWNER / TEST-REPO ';
    const gh = github(pr());

    const events = await run({ github: gh, context: createMockContext(), core });

    expect(events).toEqual([]);
    expect(gh.rest.pulls.get).not.toHaveBeenCalled();
    expect(gh.rest.pulls.updateBranch).not.toHaveBeenCalled();
    expect(gh.rest.repos.getCombinedStatusForRef).not.toHaveBeenCalled();
    expect(gh.rest.repos.createCommitStatus).not.toHaveBeenCalled();
    expect(JSON.stringify({ infos: core.infos, warnings: core.warnings, output: core.getOutput('events') })).not.toContain('test-owner/test-repo');
    expect(core.infos).toContain('skipped 1 reconcile target in excluded repositories');
  });

  it('keeps the existing behavior when the exclusion list is empty', async () => {
    process.env.PR_RECONCILE_EXCLUDE_REPOS = ' ,  ';
    const gh = github(pr({ mergeable_state: 'behind' }));

    const [event] = await run({ github: gh, context: createMockContext(), core });

    expect(gh.rest.pulls.get).toHaveBeenCalledTimes(1);
    expect(gh.rest.pulls.updateBranch).toHaveBeenCalledTimes(1);
    expect(event).toMatchObject({ pr: 7, action: 'update-branch', outcome: 'updated' });
    expect(core.infos.some((message) => message.includes('skipped'))).toBe(false);
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

  it('lists no check runs when the CI fix workflow is unset', async () => {
    const gh = github(pr());
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.paginate).not.toHaveBeenCalled();
    expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(event).toMatchObject({ action: 'none', outcome: 'noop' });
    expect('check' in event).toBe(false);
  });

  it('dispatches the CI fix workflow once for a failed check and records it', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const gh = github(pr({ base: { ref: 'develop', repo: { full_name: 'test-owner/test-repo', default_branch: 'main' } } }));
    gh.paginate.mockResolvedValueOnce([checkRun({ name: 'ci-unit' })]);
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
    expect(gh.rest.actions.createWorkflowDispatch.mock.calls[0][0]).toEqual({
      owner: 'test-owner', repo: 'test-repo', workflow_id: 'openhands-ci-fix.yml', ref: 'main',
      inputs: { failure_run_id: '424242', failure_head_branch: 'feat/x' },
    });
    expect(gh.rest.repos.createCommitStatus.mock.calls.map((c) => c[0])).toContainEqual(expect.objectContaining({ sha: 'head1', context: 'pr-reconcile', description: 'ci-fix' }));
    expect(event).toMatchObject({ action: 'ci-fix', outcome: 'ci-fix-dispatched', check: 'ci-unit' });
  });

  it('merges the base in first when the failed check passes at the base tip', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const gh = github(pr());
    gh.paginate.mockResolvedValueOnce([checkRun({ name: 'ci-render' })]);
    gh.paginate.mockResolvedValueOnce([checkRun({ name: 'ci-render', conclusion: 'success' })]);
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.paginate.mock.calls[1][1]).toMatchObject({ ref: 'develop', check_name: 'ci-render' });
    expect(gh.rest.pulls.updateBranch).toHaveBeenCalledWith({ owner: 'test-owner', repo: 'test-repo', pull_number: 7, expected_head_sha: 'head1' });
    expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(gh.rest.repos.createCommitStatus.mock.calls.map((c) => c[0])).toContainEqual(expect.objectContaining({ sha: 'head1', context: 'pr-reconcile', description: 'ci-fix' }));
    expect(event).toMatchObject({ action: 'ci-fix', outcome: 'base-merged', check: 'ci-render' });
  });

  it('dispatches the CI fix when the base already merged in cannot be updated', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const gh = github(pr());
    gh.paginate.mockResolvedValueOnce([checkRun({ name: 'ci-render' })]);
    gh.paginate.mockResolvedValueOnce([checkRun({ name: 'ci-render', conclusion: 'success' })]);
    gh.rest.pulls.updateBranch.mockRejectedValue(Object.assign(new Error('up to date'), { status: 422 }));
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
    expect(event).toMatchObject({ action: 'ci-fix', outcome: 'ci-fix-dispatched', check: 'ci-render' });
  });

  it('does not merge the base in when the check also fails at the base tip', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const gh = github(pr());
    gh.paginate.mockResolvedValueOnce([checkRun({ name: 'ci-render' })]);
    gh.paginate.mockResolvedValueOnce([checkRun({ name: 'ci-render' })]);
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.pulls.updateBranch).not.toHaveBeenCalled();
    expect(event).toMatchObject({ outcome: 'ci-fix-dispatched' });
  });

  it('waits while a check run is not completed', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const gh = github(pr());
    gh.paginate.mockResolvedValueOnce([checkRun({ status: 'in_progress' })]);
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(event).toMatchObject({ action: 'ci-fix', outcome: 'ci-pending' });
    expect('check' in event).toBe(false);
  });

  it('ignores failed checks a code edit cannot fix', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    for (const name of [
      'gate / AI Merge Gate', 'Merge Gate', 'gate / Review router availability',
      'release-freeze', 'release-notes / Check eligibility', 'Flake Lock Fresh / Flake inputs at branch head',
    ]) {
      const gh = github(pr());
      gh.paginate.mockResolvedValueOnce([checkRun({ name })]);
      const [event] = await run({ github: gh, context: createMockContext(), core });
      expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
      expect(event).toMatchObject({ action: 'ci-fix', outcome: 'noop' });
    }
  });

  it('dispatches a fix for review verdicts, workflow policy and scans', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    for (const name of [
      'gate / Semantic review / Policy gate', 'gate / Security review / Policy gate', 'Workflow Policy',
      'CodeQL', 'gate / Dependency Review',
    ]) {
      const gh = github(pr());
      gh.paginate.mockResolvedValueOnce([checkRun({ name })]);
      const [event] = await run({ github: gh, context: createMockContext(), core });
      expect(gh.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
      expect(event).toMatchObject({ action: 'ci-fix', outcome: 'ci-fix-dispatched', check: name });
    }
  });

  it('re-runs a crashed or cancelled AI review and Uses Resolve, never a CI-fix dispatch, twice per head', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    for (const check of [checkRun({ name: 'gate / Code review / Review the diff', conclusion: 'cancelled' }), checkRun({ name: 'shared-gate / Uses Resolve' })]) {
      const gh = github(pr(), { statuses: [{ context: 'pr-reconcile-rerun', description: 'rerun 1: x' }] });
      gh.paginate.mockResolvedValueOnce([check]);
      const [event] = await run({ github: gh, context: createMockContext(), core });
      expect(gh.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledWith({ owner: 'test-owner', repo: 'test-repo', run_id: 424242 });
      expect(gh.rest.repos.createCommitStatus.mock.calls.map((c) => c[0])).toContainEqual(expect.objectContaining({
        sha: 'head1', context: 'pr-reconcile-rerun', description: `rerun 2: ${check.name}`,
      }));
      expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
      expect(event).toMatchObject({ action: 'ci-fix', outcome: 'rerun', check: check.name });
    }
  });

  it('re-runs a check that keeps failing on sweeps 1 and 2, then stops (combined status: one per context)', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const name = 'gate / Code review / Review the diff';
    const latest = new Map();
    const sweeps = [];
    for (let sweep = 0; sweep < 3; sweep += 1) {
      const gh = github(pr(), { statuses: [...latest.values()] });
      gh.rest.repos.createCommitStatus.mockImplementation(async (status) => { latest.set(status.context, status); return {}; });
      gh.paginate.mockResolvedValueOnce([checkRun({ name, conclusion: 'cancelled' })]);
      const [event] = await run({ github: gh, context: createMockContext(), core });
      sweeps.push([event.outcome, gh.rest.actions.reRunWorkflowFailedJobs.mock.calls.length, latest.get('pr-reconcile-rerun')?.description]);
    }
    expect(sweeps).toEqual([
      ['rerun', 1, `rerun 1: ${name}`],
      ['rerun', 1, `rerun 2: ${name}`],
      ['noop', 0, `rerun 2: ${name}`],
    ]);
  });

  it('re-runs a Policy gate job that failed in its gateway step, and after two re-runs leaves it alone', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const name = 'gate / Semantic review / Policy gate';
    const check = checkRun({ name, details_url: 'https://github.com/test-owner/test-repo/actions/runs/424242/job/77' });
    for (const [statuses, outcome, reruns] of [
      [[], 'rerun', 1],
      [[{ context: 'pr-reconcile-rerun', description: `rerun 2: ${name}` }], 'noop', 0],
    ]) {
      const gh = github(pr(), { statuses });
      gh.rest.actions.getJobForWorkflowRun = mock().mockResolvedValue({
        data: { steps: [{ name: 'Report gateway unavailability', conclusion: 'failure' }] },
      });
      gh.paginate.mockResolvedValueOnce([check]);
      const [event] = await run({ github: gh, context: createMockContext(), core });
      expect(gh.rest.actions.getJobForWorkflowRun).toHaveBeenCalledWith({ owner: 'test-owner', repo: 'test-repo', job_id: 77 });
      expect(gh.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledTimes(reruns);
      expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
      expect(event).toMatchObject({ action: 'ci-fix', outcome });
    }
  });

  it('sends a Policy gate job that failed on its verdict to the CI fix', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const name = 'gate / Semantic review / Policy gate';
    const gh = github(pr());
    gh.rest.actions.getJobForWorkflowRun = mock().mockResolvedValue({
      data: { steps: [{ name: 'Enforce the verdict', conclusion: 'failure' }] },
    });
    gh.paginate.mockResolvedValueOnce([checkRun({ name, details_url: 'https://github.com/test-owner/test-repo/actions/runs/424242/job/78' })]);
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
    expect(event).toMatchObject({ action: 'ci-fix', outcome: 'ci-fix-dispatched', check: name });
  });

  it('after two re-runs leaves an AI review alone and sends Uses Resolve to the CI fix', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const statuses = [{ context: 'pr-reconcile-rerun', description: 'rerun 2: x' }];
    for (const [name, outcome] of [['gate / Code review / Review the diff', 'noop'], ['shared-gate / Uses Resolve', 'ci-fix-dispatched']]) {
      const gh = github(pr(), { statuses });
      gh.paginate.mockResolvedValueOnce([checkRun({ name })]);
      const [event] = await run({ github: gh, context: createMockContext(), core });
      expect(gh.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
      expect(event).toMatchObject({ action: 'ci-fix', outcome });
    }
  });

  it('merges the base in for a skipped check that passes on the base, such as Flake Lock Fresh', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const name = 'Flake Lock Fresh / Flake inputs at branch head';
    const gh = github(pr());
    gh.paginate.mockResolvedValueOnce([checkRun({ name })]).mockResolvedValueOnce([{ status: 'completed', conclusion: 'success' }]);
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.pulls.updateBranch).toHaveBeenCalledWith({ owner: 'test-owner', repo: 'test-repo', pull_number: 7, expected_head_sha: 'head1' });
    expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(event).toMatchObject({ action: 'ci-fix', outcome: 'base-merged', check: name });
  });

  it('ignores failing checks that are not github-actions', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const gh = github(pr());
    gh.paginate.mockResolvedValueOnce([checkRun({ app: { slug: 'other-ci' } })]);
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(event.outcome).toBe('noop');
  });

  it('replaces the default skip pattern with CI_FIX_SKIP_CHECKS', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    process.env.CI_FIX_SKIP_CHECKS = '^docs';
    const gh = github(pr());
    gh.paginate.mockResolvedValueOnce([
      checkRun({ name: 'codeql' }),
      checkRun({ name: 'docs build' }),
    ]);
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
    expect(event.check).toBe('codeql');
  });

  it('picks the alphabetically first failed check so the choice is stable', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const gh = github(pr({ base: { ref: 'develop', repo: { full_name: 'test-owner/test-repo', default_branch: 'main' } } }));
    gh.paginate.mockResolvedValueOnce([
      checkRun({ name: 'zeta job', details_url: 'https://github.com/test-owner/test-repo/actions/runs/111' }),
      checkRun({ name: 'alpha job', details_url: 'https://github.com/test-owner/test-repo/actions/runs/222' }),
    ]);
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.actions.createWorkflowDispatch.mock.calls[0][0].inputs).toEqual({ failure_run_id: '222', failure_head_branch: 'feat/x' });
    expect(event.check).toBe('alpha job');
  });

  it('reports a failed check whose URLs carry no workflow run id', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const gh = github(pr());
    gh.paginate.mockResolvedValueOnce([checkRun({ details_url: 'https://github.com/test-owner/test-repo/check-run/1', html_url: 'https://github.com/test-owner/test-repo/check-run/1' })]);
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(event).toMatchObject({ action: 'ci-fix', outcome: 'ci-fix-no-run', check: 'ci-unit' });
  });

  it('records ci-fix-no-caller when the repository has no such workflow', async () => {
    process.env.CI_FIX_WORKFLOW = 'missing-ci-fix.yml';
    const gh = github(pr({ base: { ref: 'develop', repo: { full_name: 'test-owner/test-repo', default_branch: 'main' } } }));
    gh.paginate.mockResolvedValueOnce([checkRun()]);
    gh.rest.actions.createWorkflowDispatch.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
    expect(event).toMatchObject({ action: 'ci-fix', outcome: 'ci-fix-no-caller', check: 'ci-unit' });
    expect(gh.rest.repos.createCommitStatus.mock.calls.map((c) => c[0])).toContainEqual(expect.objectContaining({ context: 'pr-reconcile', description: 'ci-fix' }));
  });

  it('reports a 403 dispatch error without recording it', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const gh = github(pr({ base: { ref: 'develop', repo: { full_name: 'test-owner/test-repo', default_branch: 'main' } } }));
    gh.paginate.mockResolvedValueOnce([checkRun()]);
    gh.rest.actions.createWorkflowDispatch.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(event).toMatchObject({ action: 'ci-fix', outcome: 'error:403' });
    expect(gh.rest.repos.createCommitStatus.mock.calls.map((c) => c[0].description)).not.toContain('ci-fix');
  });

  it('does not start a CI fix for a held, promotion, fork, release or Renovate pull request', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const held = github(pr({ labels: [{ name: 'merge-hold' }] }));
    await run({ github: held, context: createMockContext(), core });
    expect(held.paginate).not.toHaveBeenCalled();
    expect(held.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();

    const promotion = github(pr({ head: { ref: 'develop', sha: 'head1', repo: { full_name: 'test-owner/test-repo' } }, base: { ref: 'main', repo: { full_name: 'test-owner/test-repo', default_branch: 'main' } } }));
    await run({ github: promotion, context: createMockContext(), core });
    expect(promotion.paginate).not.toHaveBeenCalled();
    expect(promotion.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();

    const fork = github(pr({ head: { ref: 'feat/x', sha: 'head1', repo: { full_name: 'fork-owner/test-repo' } } }));
    await run({ github: fork, context: createMockContext(), core });
    expect(fork.paginate).not.toHaveBeenCalled();
    expect(fork.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();

    const release = github(pr({ head: { ref: 'release-please--branches--main', sha: 'head1', repo: { full_name: 'test-owner/test-repo' } } }));
    await run({ github: release, context: createMockContext(), core });
    expect(release.paginate).not.toHaveBeenCalled();
    expect(release.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();

    const renovate = github(pr({ user: { login: 'renovate[bot]' } }));
    await run({ github: renovate, context: createMockContext(), core });
    expect(renovate.paginate).not.toHaveBeenCalled();
    expect(renovate.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('does not start a CI fix when classify acts, even with failed checks', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const gh = github(pr({ mergeable_state: 'behind' }));
    gh.paginate.mockResolvedValueOnce([checkRun()]);
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.pulls.updateBranch).toHaveBeenCalledTimes(1);
    expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(event.outcome).toBe('updated');
  });

  it('does not start a CI fix for a closed pull request', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const gh = github(pr({ state: 'closed' }));
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.paginate).not.toHaveBeenCalled();
    expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(event).toMatchObject({ state: 'closed', action: 'none', outcome: 'noop' });
  });

  it('reports already-done on a second sweep at the same head without listing checks', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    const gh = github(pr(), { statuses: [{ context: 'pr-reconcile', description: 'ci-fix' }] });
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.paginate).not.toHaveBeenCalled();
    expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(event).toMatchObject({ action: 'ci-fix', outcome: 'already-done' });
  });

  it('refuses a CI fix workflow name that is not a plain file name', async () => {
    process.env.CI_FIX_WORKFLOW = 'ci fix.yml';
    await expect(run({ github: github(pr()), context: createMockContext(), core })).rejects.toThrow('invalid CI_FIX_WORKFLOW');
  });

  it('refuses an invalid CI_FIX_SKIP_CHECKS pattern', async () => {
    process.env.CI_FIX_WORKFLOW = 'openhands-ci-fix.yml';
    process.env.CI_FIX_SKIP_CHECKS = 'unbalanced(';
    await expect(run({ github: github(pr()), context: createMockContext(), core })).rejects.toThrow('invalid CI_FIX_SKIP_CHECKS');
  });
});

describe('conflict fix', () => {
  let core;
  const DAY = 24 * 60 * 60 * 1000;
  const MIN_AGE = 15 * 60 * 1000;
  const conflictPrs = () => core.setOutput.mock.calls.filter((c) => c[0] === 'conflict_prs').map((c) => c[1]);
  const dirty = (overrides = {}) => pr({
    mergeable_state: 'dirty',
    base: { ref: 'develop', repo: { full_name: 'test-owner/test-repo', default_branch: 'develop' } },
    ...overrides,
  });
  function conflictGithub(prData, { statuses = [], files = [{ filename: 'src/a.js' }], ageMs = 2 * DAY, v2 = false } = {}) {
    const gh = github(prData, { statuses, files });
    gh.rest.repos.getCommit.mockResolvedValue({ data: { commit: { committer: { date: new Date(Date.now() - ageMs).toISOString() } } } });
    gh.rest.git = { getRef: v2 ? mock().mockResolvedValue({}) : mock().mockRejectedValue(Object.assign(new Error('nf'), { status: 404 })) };
    return gh;
  }
  const conflictStatuses = (gh) => gh.rest.repos.createCommitStatus.mock.calls.map((c) => c[0]).filter((s) => s.context === 'pr-reconcile-conflict');

  beforeEach(() => {
    core = createMockCore();
    core.summary = { addRaw: mock(() => core.summary), write: mock(async () => {}) };
    delete process.env.RESOLVER_REPO;
    delete process.env.CI_FIX_SKIP_CHECKS;
    delete process.env.MERGE_ENABLED;
    delete process.env.CONFLICT_OUTPUT;
    process.env.CI_FIX_WORKFLOW = 'ci-fix.yml';
    process.env.PR_NUMBER = '7';
  });

  it('dispatches a conflict that changes a .github data file outside the CI paths', async () => {
    const gh = conflictGithub(dirty(), { files: [{ filename: '.github/router-contracts.yml' }] });
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
    expect(event.conflict.outcome).not.toBe('conflict-skip');
  });

  it('dispatches the caller with conflict_pr for a conflict whose head is 15 minutes old', async () => {
    const gh = conflictGithub(dirty(), { ageMs: MIN_AGE });
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.actions.createWorkflowDispatch.mock.calls[0][0]).toEqual({
      owner: 'test-owner', repo: 'test-repo', workflow_id: 'ci-fix.yml', ref: 'develop',
      inputs: { failure_head_branch: 'feat/x', conflict_pr: '7' },
    });
    expect(gh.rest.git.getRef.mock.calls[0][0].ref).toBe('heads/feat/x-v2');
    expect(conflictStatuses(gh)).toEqual([expect.objectContaining({ sha: 'head1', description: 'conflict-dispatched 1' })]);
    expect(event.conflict).toEqual({ outcome: 'conflict-dispatched', reason: 'ci-fix.yml' });
    expect(core.summary.addRaw.mock.calls[0][0]).toContain('| test-owner/test-repo#7 | conflict-dispatched | ci-fix.yml |');

  });

  const record = (description, ageMs) => ({ context: 'pr-reconcile-conflict', description, created_at: new Date(Date.now() - ageMs).toISOString() });

  it('retries an attempt that left the original open after 45 minutes, at most twice per head', async () => {
    const running = conflictGithub(dirty(), { statuses: [record('conflict-dispatched 1', 44 * 60 * 1000)] });
    const [first] = await run({ github: running, context: createMockContext(), core });
    expect(running.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(first.conflict).toEqual({ outcome: 'conflict-skip', reason: 'conflict-dispatched 1 under 45 min ago' });

    for (const legacy of ['conflict-dispatched 1', 'conflict-dispatched']) {
      const failed = conflictGithub(dirty(), { statuses: [record(legacy, 46 * 60 * 1000)] });
      const [retry] = await run({ github: failed, context: createMockContext(), core });
      expect(failed.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
      expect(conflictStatuses(failed)).toEqual([expect.objectContaining({ sha: 'head1', description: 'conflict-dispatched 2' })]);
      expect(retry.conflict).toEqual({ outcome: 'conflict-dispatched', reason: 'ci-fix.yml' });
    }

    for (const final of ['conflict-dispatched 2', 'conflict-lead']) {
      const spent = conflictGithub(dirty(), { statuses: [record(final, 2 * DAY)] });
      const [skip] = await run({ github: spent, context: createMockContext(), core });
      expect(spent.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
      expect(skip.conflict).toEqual({ outcome: 'conflict-skip', reason: `already ${final}` });
    }
  });

  const skips = [
    ['a head commit its author pushed under 15 minutes ago', {}, { ageMs: MIN_AGE - 60000 }, 'head commit under 15 min old'],
    ['a pull request that touches workflow files', {}, { files: [{ filename: '.github/workflows/ci.yml' }] }, 'CI paths'],
    ['a pull request that touches a composite action', {}, { files: [{ filename: '.github/actions/run/action.yml' }] }, 'CI paths'],
    ['a pull request already sent to the lead', { labels: [{ name: 'needs-lead' }] }, {}, 'needs-lead'],
    ['an original whose v2 branch exists', {}, { v2: true }, 'v2 branch exists'],
  ];
  for (const [name, prOverrides, options, reason] of skips) {
    it(`skips ${name} and logs the reason`, async () => {
      const gh = conflictGithub(dirty(prOverrides), options);
      const [event] = await run({ github: gh, context: createMockContext(), core });
      expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
      expect(event.conflict).toEqual({ outcome: 'conflict-skip', reason });
      expect(core.summary.addRaw.mock.calls[0][0]).toContain(reason);
    });
  }

  it('sends a v2 that conflicts again to the lead and never dispatches a v3', async () => {
    for (const overrides of [{ head: { ref: 'feat/x-v2', sha: 'head1', repo: { full_name: 'test-owner/test-repo' } } }, { body: 'Intro\n\nSupersedes #5' }]) {
      const gh = conflictGithub(dirty(overrides));
      const [event] = await run({ github: gh, context: createMockContext(), core });
      expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
      expect(gh.rest.issues.addLabels.mock.calls.map((c) => c[0].labels)).toContainEqual(['needs-lead']);
      expect(event.conflict.outcome).toBe('conflict-lead');
    }
  });

  for (const [status, outcome] of [[422, 'conflict-no-input'], [404, 'conflict-no-caller']]) {
    it(`records nothing for an HTTP ${status} dispatch, logs it, and retries on the next sweep`, async () => {
      const gh = conflictGithub(dirty());
      gh.rest.actions.createWorkflowDispatch.mockRejectedValue(Object.assign(new Error('refused'), { status }));
      const [event] = await run({ github: gh, context: createMockContext(), core });
      expect(event.conflict).toEqual({ outcome, reason: `HTTP ${status}; retried next sweep` });
      expect(conflictStatuses(gh)).toEqual([]);
      expect(core.summary.addRaw.mock.calls[0][0]).toContain(outcome);

      const next = conflictGithub(dirty());
      await run({ github: next, context: createMockContext(), core });
      expect(next.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
    });
  }

  it('does nothing for a held, Renovate or promotion conflict or without a CI fix workflow', async () => {
    const cases = [
      dirty({ labels: [{ name: 'merge-hold' }] }),
      dirty({ user: { login: 'renovate[bot]' }, body: 'x\n- [ ] <!-- rebase-check -->' }),
      dirty({ head: { ref: 'develop', sha: 'h', repo: { full_name: 'test-owner/test-repo' } }, base: { ref: 'main', repo: { full_name: 'test-owner/test-repo', default_branch: 'develop' } } }),
    ];
    for (const prData of cases) {
      const gh = conflictGithub(prData);
      const [event] = await run({ github: gh, context: createMockContext(), core });
      expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
      expect(event.conflict).toBeUndefined();
    }
    delete process.env.CI_FIX_WORKFLOW;
    const gh = conflictGithub(dirty());
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(event.conflict).toBeUndefined();
  });

  it('queues instead of dispatching with CONFLICT_OUTPUT, counting attempts per head, even without a CI fix workflow', async () => {
    process.env.CONFLICT_OUTPUT = 'true';
    delete process.env.CI_FIX_WORKFLOW;
    const gh = conflictGithub(dirty());
    const [event] = await run({ github: gh, context: createMockContext(), core });
    expect(gh.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(conflictStatuses(gh)).toEqual([expect.objectContaining({ sha: 'head1', description: 'conflict-queued 1' })]);
    expect(event.conflict).toEqual({ outcome: 'conflict-queued', reason: 'conflict_prs output' });
    expect(conflictPrs()).toEqual(['["7"]']);

    const again = conflictGithub(dirty(), { statuses: [record('conflict-queued', 46 * 60 * 1000)] });
    const [second] = await run({ github: again, context: createMockContext(), core });
    expect(conflictStatuses(again)).toEqual([expect.objectContaining({ sha: 'head1', description: 'conflict-queued 2' })]);
    expect(conflictPrs()[1]).toBe('["7"]');

    const spent = conflictGithub(dirty(), { statuses: [record('conflict-queued 2', 46 * 60 * 1000)] });
    const [third] = await run({ github: spent, context: createMockContext(), core });
    expect(third.conflict).toEqual({ outcome: 'conflict-skip', reason: 'already conflict-queued 2' });
    expect(conflictPrs()[2]).toBe('[]');
    expect(second.conflict.outcome).toBe('conflict-queued');
  });

  it('sets conflict_prs to [] when nothing is queued, including dispatch mode and a skipped head', async () => {
    await run({ github: conflictGithub(dirty()), context: createMockContext(), core });
    process.env.CONFLICT_OUTPUT = 'true';
    await run({ github: conflictGithub(dirty(), { ageMs: MIN_AGE - 60000 }), context: createMockContext(), core });
    await run({ github: conflictGithub(pr()), context: createMockContext(), core });
    expect(conflictPrs()).toEqual(['[]', '[]', '[]']);
  });

  it('wires conflict_fix from the reusable workflow to the conflict_prs output', () => {
    const workflow = readFileSync('.github/workflows/pr-reconcile.yml', 'utf8');
    const action = readFileSync('.github/actions/pr-reconcile-run/action.yml', 'utf8');
    expect(workflow).toContain('          conflict_output: ${{ inputs.conflict_fix }}\n');
    expect(workflow).toContain('        value: ${{ jobs.reconcile.outputs.conflict_prs }}\n');
    expect(workflow).toContain("      conflict_prs: ${{ steps.reconcile.outputs.conflict_prs || '[]' }}\n");
    expect(action).toContain('        CONFLICT_OUTPUT: ${{ inputs.conflict_output }}\n');
    expect(action).toContain('    value: ${{ steps.reconcile.outputs.conflict_prs }}\n');
  });

  it('keeps the action record and the conflict record in separate status contexts', async () => {
    const gh = conflictGithub(dirty());
    await run({ github: gh, context: createMockContext(), core });
    const contexts = gh.rest.repos.createCommitStatus.mock.calls.map((c) => [c[0].context, c[0].description]);
    expect(contexts).toContainEqual(['pr-reconcile', 'label-conflict']);
    expect(contexts).toContainEqual(['pr-reconcile-conflict', 'conflict-dispatched 1']);
  });
});
