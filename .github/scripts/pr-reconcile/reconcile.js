// pr-reconcile: keep open pull requests mergeable without a model.
//
// One idempotent reconcile(pr) per pull request. The state comes only from
// GitHub API fields. BEHIND gets the update-branch API. DIRTY gets the
// merge-conflict label (and needs-lead when CI paths (ci-paths.js) are involved, which
// this token cannot write); a resolver is started by repository_dispatch when
// RESOLVER_REPO is set. Each decision is logged as one JSON event line.
//
// CI fix: when CI_FIX_WORKFLOW names a workflow file, a pull request that is
// otherwise left alone but has failed github-actions checks gets one
// workflow_dispatch per head commit to fix them, and another every CI_FIX_RETRY_MS
// while that head stays red; the fixer's own attempt cap bounds the total. CI_FIX_SKIP_CHECKS is a
// case-insensitive regex of check names a coding agent should not touch.
// When the failed check passes at the tip of the base branch, the base is merged
// in first (update-branch) and no fix is dispatched for that head; this applies to skipped checks too.
// Re-run first: an AI review run that crashed or was cancelled, and Uses Resolve (it reads live references), get
// a re-run of their workflow run instead, at most twice per head (the pr-reconcile-rerun status counts them). An
// AI review never gets a CI-fix dispatch.
//
// Hold: every reconcile sets the `merge-hold` commit status at the head: failure
// while the PR carries the merge-hold label, success otherwise. A ruleset that
// requires this status blocks the merge itself, so re-armed auto-merge cannot
// race a hold, and the PR stays ready and mergeable.
//
// Conflict fix: when CI_FIX_WORKFLOW is set, a conflicted pull request (not Renovate, not a promotion, not touching
// a CI path, ci-paths.js) whose head commit is at least 15 minutes old gets a workflow_dispatch with conflict_pr, at most
// CONFLICT_MAX per head per day: an attempt that left the original open with no v2 branch is retried after
// CONFLICT_RETRY_MS, and a count older than CONFLICT_RESET_MS starts over, since a conflicted head does not move;
// the caller opens a v2 pull request on the current base. A v2 that conflicts again gets needs-lead, never a v3.
// The commit status context pr-reconcile-conflict records it, apart from the pr-reconcile action record. A
// repository without a caller that takes conflict_pr records nothing and is retried every sweep.
// With CONFLICT_OUTPUT=true the same checks queue the pull request instead of dispatching: the run records
// conflict-queued at the head and returns the numbers in the conflict_prs output, so the calling workflow starts
// the conflict fix as a reusable-workflow job (no dispatch, no actions permission).
//
// Merge: when MERGE_ENABLED is true, a bot pull request left alone otherwise is merged once it is green at its exact
// head (merge.js); every merge and skip reason goes to the run summary.
//
// Modes: PR_NUMBER (one PR in this repo), BASE_REF (every open PR on that base,
// for push-to-base), SWEEP_OWNER (every open PR of the owner).

const { mergeEnabled, tryMerge, mergeSummary, GATE_CHECK } = require('./merge.js');
const { isCiPath } = require('./ci-paths.js');

const CONFLICT_LABEL = 'merge-conflict';
const LEAD_LABEL = 'needs-lead';
const STATUS_CONTEXT = 'pr-reconcile';
const HOLD_CONTEXT = 'merge-hold';
const HOLD_LABEL = 'merge-hold';
const UNKNOWN_RETRIES = 3;
const CONFLICT_CONTEXT = 'pr-reconcile-conflict';
// The author's own push gets 15 minutes to settle before a fix starts.
const CONFLICT_MIN_AGE_MS = 15 * 60 * 1000;
const CONFLICT_MAX = 2;
const CONFLICT_RETRY_MS = 45 * 60 * 1000; // longer than one conflict-fix run, so a running attempt is not doubled
const CONFLICT_RESET_MS = 24 * 60 * 60 * 1000;
// A fix that committed nothing leaves the head where it was, so the same head is looked at again after this long.
const CI_FIX_RETRY_MS = 6 * 60 * 60 * 1000;
const V2_BODY = /^Supersedes #\d+\b/m;
// Unknown-state retries stop after the retry budget; no new PR starts after the run budget, so a large sweep
// ends inside the 5-minute job timeout and the next sweep picks up the rest.
let retryDeadline = Infinity;
const RENOVATE_UNCHECKED = '- [ ] <!-- rebase-check -->';
const RENOVATE_CHECKED = '- [x] <!-- rebase-check -->';
// Checks a code edit cannot fix: gate aggregators that mirror another check, review-router outages, review runs
// that crashed instead of returning a verdict, release freezes and release checks, and eligibility gates. Review
// verdicts (Policy gate), Workflow Policy, CodeQL and dependency review do start a fix.
// Flake Lock Fresh fails on upstream drift of the base's lock file: a lock bump on the base and update-branch clear it.
const CI_FIX_SKIP_DEFAULT = 'merge gate|router availability|review the diff|freeze|release|eligibility|flake lock fresh';
const RERUN_CHECKS = /review the diff|uses resolve/i;
const RERUN_CONTEXT = 'pr-reconcile-rerun';
const RERUN_MAX = 2;
const GATEWAY_STEP = /gateway unavailab/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function classify(pr) {
  const labels = (pr.labels || []).map((label) => label.name);
  if (pr.state !== 'open') return { state: 'closed', action: 'none' };
  if (!pr.head.repo || pr.head.repo.full_name !== pr.base.repo.full_name) return { state: 'fork', action: 'skip' };
  if (pr.head.ref.startsWith('release-please--')) return { state: pr.mergeable_state, action: 'skip' };
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

async function getPr(github, owner, repo, number) {
  let pr;
  for (let attempt = 0; attempt < UNKNOWN_RETRIES; attempt += 1) {
    ({ data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number }));
    if (pr.mergeable_state !== 'unknown') return pr;
    if (attempt === UNKNOWN_RETRIES - 1 || Date.now() > retryDeadline) break;
    await sleep(module.exports.retryDelayMs);
  }
  return pr;
}

async function touchesWorkflows(github, owner, repo, number) {
  const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 });
  return files.some((file) => isCiPath(file.filename));
}

// At most once per (PR, head SHA, action): the commit status at the head records the last action taken.
async function headStatuses(github, owner, repo, sha) {
  const { data } = await github.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha });
  return data.statuses || [];
}

function alreadyDone(statuses, action) {
  return statuses.some((status) => status.context === STATUS_CONTEXT && status.description === action);
}

// A record with no timestamp counts as fresh.
function olderThan(status, ms, now = Date.now()) {
  const at = Date.parse(status.updated_at || status.created_at || '');
  return Number.isFinite(at) && now - at >= ms;
}

function ciFixDone(statuses) {
  return statuses.some((status) => status.context === STATUS_CONTEXT && status.description === 'ci-fix'
    && !olderThan(status, CI_FIX_RETRY_MS));
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

async function act(github, owner, repo, pr, decision) {
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
      const resolver = process.env.RESOLVER_REPO || '';
      if (!resolver) return 'labelled';
      const [rOwner, rRepo] = resolver.split('/');
      await github.rest.repos.createDispatchEvent({
        owner: rOwner, repo: rRepo, event_type: 'pr-conflict',
        client_payload: { repository: `${owner}/${repo}`, pr: number, head_sha: pr.head.sha, base: pr.base.ref },
      });
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

function ciFixSettings() {
  const workflow = process.env.CI_FIX_WORKFLOW || '';
  if (workflow && !/^[A-Za-z0-9._-]+\.ya?ml$/.test(workflow)) throw new Error(`invalid CI_FIX_WORKFLOW: ${workflow}`);
  const pattern = process.env.CI_FIX_SKIP_CHECKS || CI_FIX_SKIP_DEFAULT;
  try {
    return { workflow, skip: new RegExp(pattern, 'i'), output: process.env.CONFLICT_OUTPUT === 'true' };
  } catch {
    throw new Error(`invalid CI_FIX_SKIP_CHECKS: ${pattern}`);
  }
}

// The CI fix applies only to pull requests the reconcile leaves alone otherwise.
function ciFixEligible(pr, held) {
  const promotion = pr.base.ref === 'main' && pr.head.ref === 'develop';
  const renovate = (pr.user && pr.user.login || '').startsWith('renovate');
  return !held && !promotion && !renovate;
}

// A github-actions check run links its workflow run in its page URLs.
function ciFixRunId(check) {
  for (const url of [check.details_url, check.html_url]) {
    const match = (url || '').match(/\/actions\/runs\/(\d+)/);
    if (match) return match[1];
  }
  return '';
}

// A head that predates a base fix fails a check the base passes; merging the base in is the fix.
async function mergeBaseFirst(github, owner, repo, pr, check) {
  const base = await github.paginate(github.rest.checks.listForRef, {
    owner, repo, ref: pr.base.ref, check_name: check.name, per_page: 100,
  });
  if (!base.some((run) => run.status === 'completed' && run.conclusion === 'success')) return false;
  try {
    await github.rest.pulls.updateBranch({ owner, repo, pull_number: pr.number, expected_head_sha: pr.head.sha });
    return true;
  } catch (error) {
    // 422: the head already contains the base, or the merge conflicts; the agent fix runs instead.
    if (error.status === 422) return false;
    throw error;
  }
}

// Re-runs one workflow run behind a re-run check while the head has fewer than RERUN_MAX recorded re-runs.
// The combined status holds only the latest status per context, so the count lives in its description: 'rerun N: ...'.
async function rerunFirst(github, owner, repo, pr, broken, statuses, down) {
  const last = statuses.find((status) => status.context === RERUN_CONTEXT);
  const done = Number(/^rerun (\d+):/.exec(last?.description || '')?.[1] || 0);
  if (done >= RERUN_MAX) return null;
  const check = broken.find((run) => (RERUN_CHECKS.test(run.name) || down.has(run)) && ciFixRunId(run));
  if (!check) return null;
  await github.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: Number(ciFixRunId(check)) });
  await github.rest.repos.createCommitStatus({
    owner, repo, sha: pr.head.sha, state: 'success', context: RERUN_CONTEXT, description: `rerun ${done + 1}: ${check.name}`.slice(0, 140),
  });
  return { outcome: 'rerun', check: check.name };
}

// A Policy gate job that failed in its gateway-unavailability step stopped before a verdict: re-run, never fixed.
async function gatewayDown(github, owner, repo, check) {
  const job = /\/job\/(\d+)/.exec(check.details_url || '')?.[1];
  if (!/policy gate/i.test(check.name) || !job) return false;
  const { data } = await github.rest.actions.getJobForWorkflowRun({ owner, repo, job_id: Number(job) });
  return (data.steps || []).some((step) => step.conclusion === 'failure' && GATEWAY_STEP.test(step.name));
}

async function startCiFix(github, owner, repo, pr, settings, statuses = []) {
  const runs = await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: pr.head.sha, per_page: 100 });
  if (runs.some((check) => check.status !== 'completed')) return { outcome: 'ci-pending' };
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const broken = runs
    .filter((check) => ['failure', 'cancelled', 'timed_out'].includes(check.conclusion)
      && check.app && check.app.slug === 'github-actions')
    .sort(byName);
  const down = new Set();
  for (const check of broken) if (await gatewayDown(github, owner, repo, check)) down.add(check);
  const rerun = await rerunFirst(github, owner, repo, pr, broken, statuses, down);
  if (rerun) return rerun;
  const failures = broken.filter((check) => check.conclusion === 'failure' && !down.has(check));
  for (const check of failures) {
    if (await mergeBaseFirst(github, owner, repo, pr, check)) return { outcome: 'base-merged', check: check.name };
  }
  const failed = failures.filter((check) => !settings.skip.test(check.name) && !/review the diff/i.test(check.name));
  if (!failed.length) return { outcome: 'noop' };
  const check = failed[0];
  const runId = ciFixRunId(check);
  if (!runId) return { outcome: 'ci-fix-no-run', check: check.name };
  try {
    await github.rest.actions.createWorkflowDispatch({
      owner, repo,
      workflow_id: settings.workflow,
      ref: pr.base.repo.default_branch,
      inputs: { failure_run_id: runId, failure_head_branch: pr.head.ref },
    });
  } catch (error) {
    // A missing caller workflow is reported once per head via record below; anything else retries next sweep.
    if (error.status === 404) return { outcome: 'ci-fix-no-caller', check: check.name };
    return { outcome: `error:${error.status || 'unknown'}`, check: check.name };
  }
  return { outcome: 'ci-fix-dispatched', check: check.name };
}

async function recordConflict(github, owner, repo, sha, outcome) {
  await github.rest.repos.createCommitStatus({
    owner, repo, sha, state: 'success', context: CONFLICT_CONTEXT, description: outcome,
  });
}

// One conflict-fix decision for a pull request the reconcile labelled as conflicted. Returns { outcome, reason }.
async function startConflictFix(github, owner, repo, pr, settings, statuses, now = Date.now()) {
  const labels = (pr.labels || []).map((label) => label.name);
  // The combined status holds only the latest status per context, so the attempt count lives in its description:
  // 'conflict-queued N' or 'conflict-dispatched N' (no N counts as 1). Any other record is final.
  const last = statuses.find((status) => status.context === CONFLICT_CONTEXT);
  const attempt = /^conflict-(?:queued|dispatched)(?: (\d+))?$/.exec(last?.description || '');
  const done = attempt && !olderThan(last, CONFLICT_RESET_MS, now) ? Number(attempt[1] || 1) : 0;
  if (last && (!attempt || done >= CONFLICT_MAX)) return { outcome: 'conflict-skip', reason: `already ${last.description}` };
  if (done && now - Date.parse(last.updated_at || last.created_at) < CONFLICT_RETRY_MS) {
    return { outcome: 'conflict-skip', reason: `${last.description} under 45 min ago` };
  }
  if (labels.includes(LEAD_LABEL)) return { outcome: 'conflict-skip', reason: 'needs-lead' };
  if (pr.head.ref.endsWith('-v2') || V2_BODY.test(pr.body || '')) {
    await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: [LEAD_LABEL] });
    await recordConflict(github, owner, repo, pr.head.sha, 'conflict-lead');
    return { outcome: 'conflict-lead', reason: 'a v2 conflicted again' };
  }
  if (await touchesWorkflows(github, owner, repo, pr.number)) return { outcome: 'conflict-skip', reason: 'CI paths' };
  const { data: commit } = await github.rest.repos.getCommit({ owner, repo, ref: pr.head.sha });
  const age = now - Date.parse(commit.commit.committer.date);
  if (!(age >= CONFLICT_MIN_AGE_MS)) return { outcome: 'conflict-skip', reason: 'head commit under 15 min old' };
  try {
    await github.rest.git.getRef({ owner, repo, ref: `heads/${pr.head.ref}-v2` });
    return { outcome: 'conflict-skip', reason: 'v2 branch exists' };
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (settings.output) {
    await recordConflict(github, owner, repo, pr.head.sha, `conflict-queued ${done + 1}`);
    return { outcome: 'conflict-queued', reason: 'conflict_prs output' };
  }
  try {
    await github.rest.actions.createWorkflowDispatch({
      owner, repo,
      workflow_id: settings.workflow,
      ref: pr.base.repo.default_branch,
      inputs: { failure_head_branch: pr.head.ref, conflict_pr: String(pr.number) },
    });
  } catch (error) {
    // 404: no caller; 422: a caller without the conflict_pr input. Nothing is recorded, so the next sweep retries
    // once the caller rollout reaches this repository.
    if (![404, 422].includes(error.status)) throw error;
    const outcome = error.status === 404 ? 'conflict-no-caller' : 'conflict-no-input';
    return { outcome, reason: `HTTP ${error.status}; retried next sweep` };
  }
  await recordConflict(github, owner, repo, pr.head.sha, `conflict-dispatched ${done + 1}`);
  return { outcome: 'conflict-dispatched', reason: settings.workflow };
}

function conflictSummary(events) {
  const rows = events.filter((event) => event.conflict)
    .map((event) => `| ${event.repository}#${event.pr} | ${event.conflict.outcome} | ${event.conflict.reason || '-'} |`);
  if (!rows.length) return '';
  return ['### Conflict fixes', '', '| Pull request | Outcome | Reason |', '| --- | --- | --- |', ...rows, ''].join('\n');
}

// The AI gate runs on pull request events only, so a head with no gate run (opened while the gate was off) waits forever.
// Where the repository runs the gate, bring the base in: the new head is the event. Renovate rebases its own branch.
async function gateRefresh(github, owner, repo, pr) {
  const workflows = await github.paginate(github.rest.actions.listRepoWorkflows, { owner, repo, per_page: 100 });
  if (!workflows.some((workflow) => workflow.state === 'active' && GATE_CHECK.test(workflow.name))) return 'no-gate-workflow';
  const renovate = (pr.user && pr.user.login || '').startsWith('renovate');
  try {
    return await act(github, owner, repo, pr, { action: renovate ? 'renovate-rebase' : 'update-branch' });
  } catch (error) {
    // 422: the head already contains the base, so the next base move refreshes it.
    if (error.status === 422) return 'up-to-date';
    throw error;
  }
}

async function reconcile({ github, core, owner, repo, number, ciFix, merge = false }) {
  const pr = await getPr(github, owner, repo, number);
  const decision = classify(pr);
  let outcome = 'noop';
  let held = false;
  let statuses = [];
  let action = decision.action;
  let check;
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
        outcome = await act(github, owner, repo, pr, decision);
        // A body-only edit (a Renovate rebase box added later) keeps the head, so only record real actions.
        if (outcome !== 'no-rebase-box') await record(github, owner, repo, pr.head.sha, decision.action);
      } catch (error) {
        outcome = `error:${error.status || 'unknown'}`;
      }
    }
  } else if (ciFix.workflow && decision.action === 'none' && decision.state !== 'closed' && ciFixEligible(pr, held)) {
    action = 'ci-fix';
    if (ciFixDone(statuses)) {
      outcome = 'already-done';
    } else {
      try {
        const fix = await startCiFix(github, owner, repo, pr, ciFix, statuses);
        outcome = fix.outcome;
        check = fix.check;
        // A missing caller workflow is final, so it is recorded like a taken action and not retried every sweep.
        if (['ci-fix-dispatched', 'ci-fix-no-caller', 'base-merged'].includes(outcome)) {
          await record(github, owner, repo, pr.head.sha, 'ci-fix');
        }
      } catch (error) {
        outcome = `error:${error.status || 'unknown'}`;
      }
    }
  }
  let conflict;
  if ((ciFix.workflow || ciFix.output) && decision.action === 'label-conflict' && !held) {
    try {
      conflict = await startConflictFix(github, owner, repo, pr, ciFix, statuses);
    } catch (error) {
      conflict = { outcome: `conflict-error:${error.status || 'unknown'}`, reason: 'api' };
    }
  }
  // A release-please branch is skipped by classify but still merges on green; a failed check never merges.
  const mergeable = decision.action === 'none' || (decision.action === 'skip' && decision.state !== 'fork');
  let mergeResult;
  if (merge && mergeable && decision.state !== 'closed' && outcome === 'noop') {
    try {
      mergeResult = await tryMerge({ github, owner, repo, pr, held, statuses });
      if (mergeResult.gateAbsent) mergeResult.refresh = await gateRefresh(github, owner, repo, pr);
    } catch (error) {
      mergeResult = { outcome: `merge-error:${error.status || 'unknown'}`, reason: 'api' };
    }
  }
  const event = {
    event: 'pr_reconcile', repository: `${owner}/${repo}`, pr: number, head_sha: pr.head.sha,
    state: decision.state, action, outcome, held,
  };
  if (check) event.check = check;
  if (mergeResult) event.merge = mergeResult;
  if (conflict) event.conflict = conflict;
  core.info(JSON.stringify(event));
  return event;
}

const SEARCH_CAP = 1000;

function excludedRepositories() {
  return new Set((process.env.PR_RECONCILE_EXCLUDE_REPOS || '')
    .split(',')
    .map((repository) => repository.replace(/\s/g, '').toLowerCase())
    .filter(Boolean));
}

function isExcludedRepository(exclusions, owner, repo) {
  return exclusions.has(`${owner}/${repo}`.toLowerCase());
}

async function targets({ github, context, core, sweepOwner }) {
  const { owner, repo } = context.repo;
  if (process.env.PR_NUMBER) return [{ owner, repo, number: Number(process.env.PR_NUMBER) }];
  if (process.env.BASE_REF) {
    const prs = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', base: process.env.BASE_REF, per_page: 100 });
    return prs.map((pr) => ({ owner, repo, number: pr.number }));
  }
  if (sweepOwner) {
    if (!/^[A-Za-z0-9-]+$/.test(sweepOwner)) throw new Error(`invalid SWEEP_OWNER: ${sweepOwner}`);
    // user: matches repositories of both user accounts and organizations; org: matches organizations only.
    const items = await github.paginate(github.rest.search.issuesAndPullRequests, {
      q: `is:pr is:open archived:false user:${sweepOwner}`, per_page: 100,
    });
    // Search returns at most 1000 results; the rest wait for a later sweep.
    if (items.length >= SEARCH_CAP) core.warning(`sweep of ${sweepOwner} truncated at ${SEARCH_CAP} pull requests`);
    return items.map((item) => {
      const [itemOwner, itemRepo] = item.repository_url.split('/').slice(-2);
      return { owner: itemOwner, repo: itemRepo, number: item.number };
    });
  }
  return [];
}

// sweepOwner is an argument, so one job can sweep several owners at once.
module.exports = async function run({ github, context, core, sweepOwner = process.env.SWEEP_OWNER }) {
  const events = [];
  const resolver = process.env.RESOLVER_REPO || '';
  if (resolver && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(resolver)) throw new Error(`invalid RESOLVER_REPO: ${resolver}`);
  const ciFix = ciFixSettings();
  const merge = mergeEnabled();
  const started = Date.now();
  retryDeadline = started + module.exports.retryBudgetMs;
  const exclusions = excludedRepositories();
  if ((process.env.PR_NUMBER || process.env.BASE_REF)
    && isExcludedRepository(exclusions, context.repo.owner, context.repo.repo)) {
    core.info('skipped 1 reconcile target in excluded repositories');
    core.setOutput('events', JSON.stringify(events));
    core.setOutput('conflict_prs', '[]');
    return events;
  }
  const all = await targets({ github, context, core, sweepOwner });
  const selected = all.filter((target) => !isExcludedRepository(exclusions, target.owner, target.repo));
  const skipped = all.length - selected.length;
  if (skipped > 0) core.info(`skipped ${skipped} pull requests in excluded repositories`);
  for (const [index, target] of selected.entries()) {
    if (Date.now() - started > module.exports.runBudgetMs) {
      core.warning(`run budget reached; ${selected.length - index} pull requests deferred to the next sweep`);
      break;
    }
    try {
      events.push(await reconcile({ github, core, ...target, ciFix, merge }));
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
  const summary = [mergeSummary(events), conflictSummary(events)].filter(Boolean).join('\n');
  if (summary) await core.summary.addRaw(summary).write();
  core.setOutput('events', JSON.stringify(events));
  const queued = events.filter((event) => event.conflict && event.conflict.outcome === 'conflict-queued');
  core.setOutput('conflict_prs', JSON.stringify(queued.map((event) => String(event.pr))));
  return events;
};
module.exports.classify = classify;
module.exports.reconcile = reconcile;
module.exports.conflictSummary = conflictSummary;
module.exports.retryDelayMs = 5000;
module.exports.retryBudgetMs = 3 * 60 * 1000;
module.exports.runBudgetMs = 4 * 60 * 1000;
