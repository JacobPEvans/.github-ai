// pr-reconcile merge: merge a bot pull request that is green at its exact head.
//
// Native auto-merge and merge queues key on required checks only, so they merge past red optional review checks.
// This path merges only when every check run and commit status at the head is complete and green, the AI Merge Gate
// check succeeded at that head (a Renovate, release-please or promotion pull request with no AI gate run uses the
// repository's Merge Gate instead), no review asks for changes, no review thread is open, and no release freeze holds the
// base. It merges with the head SHA, so a push after the read makes the merge fail instead of landing unreviewed code.
// On a git-flow repository the labelled develop-to-main promotion also merges through this path, with a merge commit.
// A pull request based on any other branch than the default branch (or main on a git-flow repository) is stacked and waits.
// A promotion that carries any major release commit is held for a human merge and noted once on the pull request. Auto-merge armed on an agent pull request is disarmed. Every decision returns a reason for the run summary.

const GATE_CHECK = /(^|\/ )AI Merge Gate$/;
const REPO_GATE_CHECK = /(^|\/ )Merge Gate$/;
const RENOVATE_BRANCH = 'renovate/';
const RENOVATE_UPDATE_APPS = ['jacobpevans-release-please[bot]'];
const BLOCK_LABELS = ['human:review', 'merge-hold', 'needs-lead'];
const FREEZE_LABEL = 'release:in-progress';
const BAD_CONCLUSIONS = ['failure', 'cancelled', 'timed_out', 'action_required', 'stale'];
const RELEASE_PLEASE = 'release-please--';
const MAJOR_RELEASE = /(^|\s|\[)v?[1-9]\d*\.0\.0\b/;
const RELEASE_HEADLINE = /chore\((?:develop|main)\): release [^\n]+/;
const MAJOR_NOTE = '<!-- pr-reconcile:major-promotion -->';

const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id headRefOid reviewDecision
      autoMergeRequest { enabledAt }
      reviewThreads(first: 100) { nodes { isResolved } }
    }
  }
}`;

function mergeEnabled() {
  return process.env.MERGE_ENABLED === 'true';
}

// A release-please title or changelog heading naming X.0.0 is a major release, which only a human merges.
function majorRelease(pr) {
  if (!pr.head.ref.startsWith(RELEASE_PLEASE)) return false;
  const headings = (pr.body || '').split('\n').filter((line) => line.startsWith('#'));
  return [pr.title || '', ...headings].some((line) => MAJOR_RELEASE.test(line));
}

// A promotion lands every release commit on its head, so any major release headline among them holds it.
// shortcut: the pull request commits API lists at most 250 commits; compare develop with main if a promotion grows past that.
async function promotionMajor(github, owner, repo, pr) {
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });
  return commits.some((commit) => {
    const match = (commit.commit.message || '').match(RELEASE_HEADLINE);
    return Boolean(match) && MAJOR_RELEASE.test(match[0]);
  });
}

// A major release lands only by human merge; leave that note on the promotion once, found by a hidden marker.
async function noteMajorPromotion(github, owner, repo, pr) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pr.number,
    per_page: 100,
  });
  if (comments.some((comment) => (comment.body || '').includes(MAJOR_NOTE))) return;
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: pr.number,
    body: 'This promotion carries a major release, so it needs a human merge instead of the sweep.\n\n' + MAJOR_NOTE,
  });
}

function staticBlocker(pr, held) {
  const labels = (pr.labels || []).map((label) => label.name);
  if (!pr.user || pr.user.type !== 'Bot') return 'not-bot';
  if (pr.draft) return 'draft';
  if (held) return 'held';
  const label = BLOCK_LABELS.find((name) => labels.includes(name));
  if (label) return `label:${label}`;
  if (pr.head.ref.startsWith('agent/zcode/')) return 'zcode-branch';
  // Only the labelled promotion on a git-flow repository is eligible to merge here; every other develop-to-main pull request waits.
  if (pr.base.ref === 'main' && pr.head.ref === 'develop'
    && (pr.base.repo.default_branch !== 'develop' || !labels.includes(FREEZE_LABEL))) return 'promotion';
  const base = pr.base.ref;
  if (base !== pr.base.repo.default_branch && !(base === 'main' && pr.base.repo.default_branch === 'develop')) return `stacked:${base}`;
  if (majorRelease(pr)) return 'major-release';
  if (!['clean', 'unstable'].includes(pr.mergeable_state)) return `state:${pr.mergeable_state}`;
  return '';
}

// A Renovate, release-please or promotion pull request with no AI gate run may pass on the repository's own Merge Gate.
// A Renovate major update keeps needing the AI gate.
function repoGateAllowed(pr) {
  return (renovatePr(pr) && !renovateMajor(pr)) || pr.head.ref.startsWith(RELEASE_PLEASE)
    || (pr.base.ref === 'main' && pr.head.ref === 'develop');
}

// Renovate itself, or the first-party update App on a renovate/ branch; any other author is not Renovate.
function renovatePr(pr) {
  return pr.user.login === 'renovate[bot]'
    || (RENOVATE_UPDATE_APPS.includes(pr.user.login) && pr.head.ref.startsWith(RENOVATE_BRANCH));
}

// Renovate marks a major update with the org preset's update:major label, a major- branch, or "major" in its Update column.
function renovateMajor(pr) {
  const labels = (pr.labels || []).map((label) => label.name);
  return labels.includes('update:major') || pr.head.ref.startsWith(`${RENOVATE_BRANCH}major-`)
    || /\|\s*major\s*\|/.test(pr.body || '');
}

// A re-run attempt stays in its check suite beside the run it replaced; judge only the newest run per suite and name.
// A same-named run from another workflow run is a separate key and still counts.
function newestRuns(runs) {
  const newest = new Map();
  for (const check of runs) {
    const key = check.check_suite?.id ? `${check.check_suite.id}:${check.name}` : check.name;
    const seen = newest.get(key);
    if (!seen || (check.id ?? 0) >= (seen.id ?? 0)) newest.set(key, check);
  }
  return [...newest.values()];
}

function checksBlocker(allRuns, statuses, pr) {
  if (!allRuns.length) return 'no-checks';
  const runs = newestRuns(allRuns);
  if (runs.some((check) => check.status !== 'completed')) return 'checks-pending';
  const bad = runs.find((check) => BAD_CONCLUSIONS.includes(check.conclusion));
  if (bad) return `check:${bad.name}`;
  // merge-hold is decided from the live label (held), not from the status written before this run.
  const status = statuses.find((item) => item.context !== 'merge-hold' && item.state !== 'success');
  if (status) return `status:${status.context}`;
  const gate = runs.find((check) => GATE_CHECK.test(check.name))
    || (repoGateAllowed(pr) ? runs.find((check) => REPO_GATE_CHECK.test(check.name)) : undefined);
  if (!gate || gate.conclusion !== 'success') return 'no-gate-success';
  return '';
}

// Same rule as the org release-freeze check: a pull request into develop waits while the open develop-to-main
// promotion carries the release label, unless it is a release-please or hotfix branch.
async function frozen(github, owner, repo, pr) {
  if (pr.base.ref !== 'develop') return false;
  if (pr.head.ref.startsWith(RELEASE_PLEASE) || pr.head.ref.startsWith('hotfix/')) return false;
  const promotions = await github.paginate(github.rest.pulls.list, {
    owner, repo, state: 'open', base: 'main', head: `${owner}:develop`, per_page: 100,
  });
  return promotions.some((item) => (item.labels || []).some((label) => label.name === FREEZE_LABEL));
}

async function tryMerge({ github, owner, repo, pr, held, statuses }) {
  const blocker = staticBlocker(pr, held);
  if (blocker === 'not-bot') return { outcome: 'merge-skip', reason: blocker };
  const { repository } = await github.graphql(PR_QUERY, { owner, repo, number: pr.number });
  const live = repository.pullRequest;
  let disarmed = false;
  if (live.autoMergeRequest && !pr.head.ref.startsWith(RELEASE_PLEASE)) {
    await github.graphql('mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }', { id: live.id });
    disarmed = true;
  }
  const skip = (reason) => ({ outcome: 'merge-skip', reason, disarmed });
  if (blocker) return skip(blocker);
  if (live.headRefOid !== pr.head.sha) return skip('head-moved');
  // A major release never merges on this path; say so on the pull request and stop.
  if (pr.base.ref === 'main' && pr.head.ref === 'develop' && await promotionMajor(github, owner, repo, pr)) {
    await noteMajorPromotion(github, owner, repo, pr);
    return skip('major-release');
  }
  if (live.reviewDecision === 'CHANGES_REQUESTED') return skip('changes-requested');
  if (live.reviewThreads.nodes.some((thread) => !thread.isResolved)) return skip('unresolved-threads');
  const runs = await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: pr.head.sha, per_page: 100 });
  const checks = checksBlocker(runs, statuses, pr);
  if (checks) return skip(checks);
  if (await frozen(github, owner, repo, pr)) return skip('release-freeze');
  const gitFlowMain = pr.base.ref === 'main' && pr.base.repo.default_branch === 'develop';
  try {
    await github.rest.pulls.merge({
      owner, repo, pull_number: pr.number, sha: pr.head.sha, merge_method: gitFlowMain ? 'merge' : 'squash',
    });
  } catch (error) {
    return { outcome: `merge-error:${error.status || 'unknown'}`, reason: 'api', disarmed };
  }
  return { outcome: 'merged', reason: '', disarmed };
}

function mergeSummary(events) {
  const rows = events.filter((event) => event.merge).map((event) => {
    const { outcome, reason, disarmed } = event.merge;
    return `| ${event.repository}#${event.pr} | ${outcome} | ${reason || '-'} | ${disarmed ? 'yes' : 'no'} |`;
  });
  if (!rows.length) return '';
  return ['### Sweep merges', '', '| Pull request | Outcome | Reason | Auto-merge disarmed |', '| --- | --- | --- | --- |', ...rows, ''].join('\n');
}

module.exports = { mergeEnabled, tryMerge, mergeSummary, majorRelease };
