// pr-reconcile: keep open pull requests mergeable without a model.
//
// One idempotent reconcile(pr) per pull request. The state comes only from
// GitHub API fields. BEHIND gets the update-branch API. DIRTY gets the
// merge-conflict label (and needs-lead when workflow files are involved, which
// this token cannot write); a resolver is started by repository_dispatch when
// RESOLVER_REPO_NAME is set. The resolver is <owner>/<RESOLVER_REPO_NAME>, where
// owner is the pull request's owner. Each decision is logged as one JSON event line.
//
// Hold: every reconcile sets the `merge-hold` commit status at the head: failure
// while the PR carries the merge-hold label, success otherwise. A ruleset that
// requires this status blocks the merge itself, so re-armed auto-merge cannot
// race a hold, and the PR stays ready and mergeable.
//
// Modes: PR_NUMBER (one PR in this repo), BASE_REF (every open PR on that base,
// for push-to-base), SWEEP_OWNER (every open PR of the owner).

const CONFLICT_LABEL = 'merge-conflict';
const LEAD_LABEL = 'needs-lead';
const STATUS_CONTEXT = 'pr-reconcile';
const HOLD_CONTEXT = 'merge-hold';
const HOLD_LABEL = 'merge-hold';
const UNKNOWN_RETRIES = 3;
// Unknown-state retries stop after the retry budget; no new PR starts after the run budget, so a large sweep
// ends inside the 5-minute job timeout and the next sweep picks up the rest.
let retryDeadline = Infinity;
const RENOVATE_UNCHECKED = '- [ ] <!-- rebase-check -->';
const RENOVATE_CHECKED = '- [x] <!-- rebase-check -->';
const OWNER_PATTERN = /^[A-Za-z0-9-]+$/;
// A repository name as GitHub allows it: letters, digits, '.', '_' and '-', in any order. '.' and '..' are reserved.
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const isRepoName = (name) => REPO_NAME_PATTERN.test(name) && name !== '.' && name !== '..';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fenced owners and repositories come from the runtime, never from this file: PR_RECONCILE_FENCE is one comma list
// of bare names, compared case-insensitively. A trailing * matches a prefix. Unset or blank means nothing is fenced.
// A full owner/repo entry would match nothing, so it is refused rather than ignored.
function fenceEntries() {
  const entries = (process.env.PR_RECONCILE_FENCE || '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const full = entries.find((entry) => entry.includes('/'));
  if (full) throw new Error(`PR_RECONCILE_FENCE entry "${full}" is a full name; list the bare owner or repository name`);
  return entries;
}

function fenced(name) {
  const value = name.toLowerCase();
  return fenceEntries().some((entry) => (entry.endsWith('*') ? value.startsWith(entry.slice(0, -1)) : value === entry));
}

function classify(pr, stale = false) {
  const labels = (pr.labels || []).map((label) => label.name);
  if (pr.state !== 'open') return { state: 'closed', action: 'none' };
  if (!pr.head.repo || pr.head.repo.full_name !== pr.base.repo.full_name) return { state: 'fork', action: 'skip' };
  if (pr.head.ref.startsWith('release-please--')) return { state: pr.mergeable_state, action: 'skip' };
  if (stale) return { state: 'mergeability-unknown', action: 'none' };
  const promotion = pr.base.ref === 'main' && pr.head.ref === 'develop';
  const renovate = (pr.user && pr.user.login || '').startsWith('renovate');
  switch (pr.mergeable_state) {
    case 'unknown':
      return { state: 'unknown', action: 'retry' };
    case 'behind':
      if (promotion) return { state: 'behind', action: 'none' };
      return { state: 'behind', action: renovate ? 'renovate-rebase' : 'update-branch' };
    case 'dirty':
      if (renovate) return { state: 'dirty', action: 'renovate-rebase' };
      if (promotion) return { state: 'dirty', action: 'label-lead' };
      return { state: 'dirty', action: 'label-conflict' };
    default:
      return { state: pr.mergeable_state, action: labels.includes(CONFLICT_LABEL) ? 'unlabel-conflict' : 'none' };
  }
}

// Only PRs that classify() acts on need the base check; forks, release-please branches and closed PRs skip it.
function actable(pr) {
  return pr.state === 'open' && Boolean(pr.head.repo) && pr.head.repo.full_name === pr.base.repo.full_name
    && !pr.head.ref.startsWith('release-please--');
}

// A PR whose base.sha lags the base branch head has mergeability computed against an old base.
async function baseIsStale(github, owner, repo, pr) {
  const { data: branch } = await github.rest.repos.getBranch({ owner, repo, branch: pr.base.ref });
  return branch.commit.sha !== pr.base.sha;
}

async function getPr(github, owner, repo, number) {
  let pr;
  let stale = false;
  for (let attempt = 0; attempt < UNKNOWN_RETRIES; attempt += 1) {
    ({ data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number }));
    stale = actable(pr) && await baseIsStale(github, owner, repo, pr);
    if (pr.mergeable_state !== 'unknown' && !stale) break;
    if (attempt === UNKNOWN_RETRIES - 1 || Date.now() > retryDeadline) break;
    await sleep(module.exports.retryDelayMs);
  }
  return { pr, stale };
}

async function touchesWorkflows(github, owner, repo, number) {
  const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 });
  return files.some((file) => file.filename.startsWith('.github/workflows/'));
}

// At most once per (PR, head SHA, action): the commit status at the head records the last action taken.
async function headStatuses(github, owner, repo, sha) {
  const { data } = await github.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha });
  return data.statuses || [];
}

function alreadyDone(statuses, action) {
  return statuses.some((status) => status.context === STATUS_CONTEXT && status.description === action);
}

async function record(github, owner, repo, sha, action) {
  await github.rest.repos.createCommitStatus({
    owner, repo, sha, state: 'success', context: STATUS_CONTEXT, description: action,
  });
}

async function setHold(github, owner, repo, pr, statuses) {
  const held = (pr.labels || []).some((label) => label.name === HOLD_LABEL);
  const state = held ? 'failure' : 'success';
  const current = statuses.find((status) => status.context === HOLD_CONTEXT);
  if (current && current.state === state) return held;
  await github.rest.repos.createCommitStatus({
    owner, repo, sha: pr.head.sha, state, context: HOLD_CONTEXT,
    description: held ? 'Held by the merge-hold label' : 'Not held',
  });
  return held;
}

function refusal(message) {
  return Object.assign(new Error(message), { status: 'resolver-refused' });
}

// The one resolver check. A pull request in <owner> is dispatched to <owner>/<RESOLVER_REPO_NAME>, so the owner is
// never chosen separately. Returns that repository, or null when no name is set. Throws when the name is not a bare
// repository name or when the resolved repository is fenced. Called from run() before any request, and from
// reconcile() before any write to a pull request.
function resolverTarget(owner) {
  const { name } = resolverName();
  if (!name) return null;
  if (!isRepoName(name)) throw new Error(`invalid resolver repository name: ${name}`);
  if (fenced(owner) || fenced(name)) throw refusal('resolver repository is fenced');
  return { owner, repo: name };
}

// RESOLVER_REPO_NAME is the resolver's name. The deprecated RESOLVER_REPO (owner/repo) is used only when the name is
// unset, and only its name part counts: the owner is always the pull request's owner. The new name wins when both are set.
function resolverName() {
  if (process.env.RESOLVER_REPO_NAME) return { name: process.env.RESOLVER_REPO_NAME, deprecated: false };
  const legacy = process.env.RESOLVER_REPO || '';
  if (!legacy) return { name: '', deprecated: false };
  const parts = legacy.split('/');
  if (parts.length !== 2 || !OWNER_PATTERN.test(parts[0]) || !isRepoName(parts[1])) throw new Error(`invalid RESOLVER_REPO: ${legacy}`);
  return { name: parts[1], deprecated: true };
}

// One repository_dispatch to the resolver. The conflict route uses the default event type.
async function dispatchEvent(github, target, owner, repo, pr, eventType = 'pr-conflict') {
  await github.rest.repos.createDispatchEvent({
    owner: target.owner, repo: target.repo, event_type: eventType,
    client_payload: { repository: `${owner}/${repo}`, pr: pr.number, head_sha: pr.head.sha, base: pr.base.ref },
  });
}

async function act(github, owner, repo, pr, decision, resolver) {
  const number = pr.number;
  switch (decision.action) {
    case 'update-branch':
      await github.rest.pulls.updateBranch({ owner, repo, pull_number: number, expected_head_sha: pr.head.sha });
      return 'updated';
    case 'renovate-rebase':
      if (!(pr.body || '').includes(RENOVATE_UNCHECKED)) return 'no-rebase-box';
      await github.rest.pulls.update({ owner, repo, pull_number: number, body: pr.body.replace(RENOVATE_UNCHECKED, RENOVATE_CHECKED) });
      return 'rebase-requested';
    case 'label-lead':
      await github.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [CONFLICT_LABEL, LEAD_LABEL] });
      return 'labelled';
    case 'label-conflict': {
      if (await touchesWorkflows(github, owner, repo, number)) {
        await github.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [CONFLICT_LABEL, LEAD_LABEL] });
        return 'labelled-lead-workflows';
      }
      await github.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [CONFLICT_LABEL] });
      if (!resolver) return 'labelled';
      await dispatchEvent(github, resolver, owner, repo, pr);
      return 'labelled-dispatched';
    }
    case 'unlabel-conflict':
      await github.rest.issues.removeLabel({ owner, repo, issue_number: number, name: CONFLICT_LABEL });
      if ((pr.labels || []).some((label) => label.name === LEAD_LABEL)) {
        await github.rest.issues.removeLabel({ owner, repo, issue_number: number, name: LEAD_LABEL });
      }
      return 'unlabelled';
    default:
      return 'noop';
  }
}

async function reconcile({ github, core, owner, repo, number }) {
  const { pr, stale } = await getPr(github, owner, repo, number);
  const decision = classify(pr, stale);
  // A conflict resolves its resolver before the first write, so a refused or fenced resolver leaves the pull request
  // with no status, label or dispatch.
  const resolver = decision.action === 'label-conflict' ? resolverTarget(owner) : null;
  let outcome = 'noop';
  let held = false;
  let statuses = [];
  if (!['closed', 'fork'].includes(decision.state)) {
    statuses = await headStatuses(github, owner, repo, pr.head.sha);
    held = await setHold(github, owner, repo, pr, statuses);
  }
  if (decision.action === 'retry') {
    outcome = 'still-unknown';
  } else if (!['none', 'skip'].includes(decision.action)) {
    if (alreadyDone(statuses, decision.action)) {
      outcome = 'already-done';
    } else {
      try {
        outcome = await act(github, owner, repo, pr, decision, resolver);
        // A body-only edit (a Renovate rebase box added later) keeps the head, so only record real actions.
        if (outcome !== 'no-rebase-box') await record(github, owner, repo, pr.head.sha, decision.action);
      } catch (error) {
        outcome = `error:${error.status || 'unknown'}`;
      }
    }
  }
  const event = {
    event: 'pr_reconcile', repository: `${owner}/${repo}`, pr: number, head_sha: pr.head.sha,
    state: decision.state, action: decision.action, outcome, held,
  };
  core.info(JSON.stringify(event));
  return event;
}

const SEARCH_CAP = 1000;

async function targets({ github, context, core }) {
  const { owner, repo } = context.repo;
  if (process.env.PR_NUMBER) return [{ owner, repo, number: Number(process.env.PR_NUMBER) }];
  if (process.env.BASE_REF) {
    const prs = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', base: process.env.BASE_REF, per_page: 100 });
    return prs.map((pr) => ({ owner, repo, number: pr.number }));
  }
  if (process.env.SWEEP_OWNER) {
    const sweepOwner = process.env.SWEEP_OWNER;
    if (!OWNER_PATTERN.test(sweepOwner)) throw new Error(`invalid SWEEP_OWNER: ${sweepOwner}`);
    // user: matches repositories of both user accounts and organizations; org: matches organizations only.
    const items = await github.paginate(github.rest.search.issuesAndPullRequests, {
      q: `is:pr is:open archived:false user:${sweepOwner}`, per_page: 100,
    });
    // Search returns at most 1000 results; the rest wait for a later sweep.
    if (items.length >= SEARCH_CAP) core.warning(`sweep of ${sweepOwner} truncated at ${SEARCH_CAP} pull requests`);
    const found = items.map((item) => {
      const [itemOwner, itemRepo] = item.repository_url.split('/').slice(-2);
      return { owner: itemOwner, repo: itemRepo, number: item.number };
    });
    // A fenced repository fails the whole owner before any pull request is read or written.
    if (found.some((target) => fenced(target.repo))) throw new Error('sweep refused: search returned a fenced repository');
    return found;
  }
  return [];
}

module.exports = async function run({ github, context, core }) {
  const events = [];
  // The owner fence and the resolver check run here, once, before any request. Every caller reaches them: the
  // sweep owner in sweep mode, otherwise the calling repository's owner.
  const owner = process.env.SWEEP_OWNER || context.repo.owner;
  if (fenced(owner)) throw new Error('run refused: owner is fenced');
  resolverTarget(owner);
  if (resolverName().deprecated) {
    core.warning('RESOLVER_REPO is deprecated: set RESOLVER_REPO_NAME. Only the name part of RESOLVER_REPO is used.');
  }
  const started = Date.now();
  retryDeadline = started + module.exports.retryBudgetMs;
  const all = await targets({ github, context, core });
  for (const [index, target] of all.entries()) {
    if (Date.now() - started > module.exports.runBudgetMs) {
      core.warning(`run budget reached; ${all.length - index} pull requests deferred to the next sweep`);
      break;
    }
    try {
      events.push(await reconcile({ github, core, ...target }));
    } catch (error) {
      // One PR that vanished or failed to read must not stop the rest of the sweep.
      const event = {
        event: 'pr_reconcile', repository: `${target.owner}/${target.repo}`, pr: target.number,
        action: 'none', outcome: `error:${error.status || 'unknown'}`,
      };
      core.warning(JSON.stringify(event));
      events.push(event);
    }
  }
  core.setOutput('events', JSON.stringify(events));
  return events;
};
module.exports.classify = classify;
module.exports.reconcile = reconcile;
module.exports.fenced = fenced;
module.exports.fenceEntries = fenceEntries;
module.exports.OWNER_PATTERN = OWNER_PATTERN;
module.exports.retryDelayMs = 5000;
module.exports.retryBudgetMs = 3 * 60 * 1000;
module.exports.runBudgetMs = 4 * 60 * 1000;
