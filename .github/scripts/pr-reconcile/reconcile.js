// pr-reconcile: keep open pull requests mergeable without a model.
//
// One idempotent reconcile(pr) per pull request. The state comes only from
// GitHub API fields. BEHIND gets the update-branch API. DIRTY gets the
// merge-conflict label (and needs-lead when workflow files are involved, which
// this token cannot write); a resolver is started by repository_dispatch when
// RESOLVER_REPO is set. Each decision is logged as one JSON event line.
//
// CI fix: when CI_FIX_WORKFLOW names a workflow file, a pull request that is
// otherwise left alone but has failed github-actions checks gets one
// workflow_dispatch per head commit to fix them. CI_FIX_SKIP_CHECKS is a
// case-insensitive regex of check names a coding agent should not touch.
//
// Hold: every reconcile sets the `merge-hold` commit status at the head: failure
// while the PR carries the merge-hold label, success otherwise. A ruleset that
// requires this status blocks the merge itself, so re-armed auto-merge cannot
// race a hold, and the PR stays ready and mergeable.
//
// Merge: when MERGE_ENABLED is true, a bot pull request left alone otherwise is merged once it is green at its exact
// head (merge.js); every merge and skip reason goes to the run summary.
//
// Modes: PR_NUMBER (one PR in this repo), BASE_REF (every open PR on that base,
// for push-to-base), SWEEP_OWNER (every open PR of the owner).

const { mergeEnabled, tryMerge, mergeSummary } = require('./merge.js');

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
// Meta gates and scans a coding agent cannot fix by editing code.
const CI_FIX_SKIP_DEFAULT = 'merge gate|review|freeze|policy|semantic|codeql|dependency|release';

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
    return { workflow, skip: new RegExp(pattern, 'i') };
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

async function startCiFix(github, owner, repo, pr, settings) {
  const runs = await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: pr.head.sha, per_page: 100 });
  if (runs.some((check) => check.status !== 'completed')) return { outcome: 'ci-pending' };
  const failed = runs
    .filter((check) => check.conclusion === 'failure'
      && check.app && check.app.slug === 'github-actions'
      && !settings.skip.test(check.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
    if (alreadyDone(statuses, 'ci-fix')) {
      outcome = 'already-done';
    } else {
      try {
        const fix = await startCiFix(github, owner, repo, pr, ciFix);
        outcome = fix.outcome;
        check = fix.check;
        // A missing caller workflow is final, so it is recorded like a taken action and not retried every sweep.
        if (['ci-fix-dispatched', 'ci-fix-no-caller'].includes(outcome)) {
          await record(github, owner, repo, pr.head.sha, 'ci-fix');
        }
      } catch (error) {
        outcome = `error:${error.status || 'unknown'}`;
      }
    }
  }
  // A release-please branch is skipped by classify but still merges on green; a failed check never merges.
  const mergeable = decision.action === 'none' || (decision.action === 'skip' && decision.state !== 'fork');
  let mergeResult;
  if (merge && mergeable && decision.state !== 'closed' && outcome === 'noop') {
    try {
      mergeResult = await tryMerge({ github, owner, repo, pr, held, statuses });
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

async function targets({ github, context, core }) {
  const { owner, repo } = context.repo;
  if (process.env.PR_NUMBER) return [{ owner, repo, number: Number(process.env.PR_NUMBER) }];
  if (process.env.BASE_REF) {
    const prs = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', base: process.env.BASE_REF, per_page: 100 });
    return prs.map((pr) => ({ owner, repo, number: pr.number }));
  }
  if (process.env.SWEEP_OWNER) {
    const sweepOwner = process.env.SWEEP_OWNER;
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

module.exports = async function run({ github, context, core }) {
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
    return events;
  }
  const all = await targets({ github, context, core });
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
  const summary = mergeSummary(events);
  if (summary) await core.summary.addRaw(summary).write();
  core.setOutput('events', JSON.stringify(events));
  return events;
};
module.exports.classify = classify;
module.exports.reconcile = reconcile;
module.exports.retryDelayMs = 5000;
module.exports.retryBudgetMs = 3 * 60 * 1000;
module.exports.runBudgetMs = 4 * 60 * 1000;
