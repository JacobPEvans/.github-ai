// Open the v2 pull request from the checked-out base tip plus the applied agent patch, then close the original.
//
// The v2 keeps the original's title and labels (never human:review, merge-conflict or needs-lead); its body is the
// original body plus `Supersedes #N`. The original is closed, with a comment linking the v2, only after the v2's
// CI has started: a check run or workflow run at the v2 head. The v2 is never armed for auto-merge. If none starts in time, the original stays open and
// the run fails.

const { openPr } = require('../shared/verified-commit.js');

const DROPPED_LABELS = new Set(['human:review', 'merge-conflict', 'needs-lead']);

function v2Body(body, number) {
  const original = (body || '').trimEnd();
  return `${original ? `${original}\n\n` : ''}Supersedes #${number}`;
}

function v2Labels(labels) {
  return (labels || []).map((label) => label.name).filter((name) => !DROPPED_LABELS.has(name));
}

async function ciStarted(github, owner, repo, sha) {
  const { data: checks } = await github.rest.checks.listForRef({ owner, repo, ref: sha, per_page: 1 });
  if (checks.total_count > 0) return true;
  const { data: runs } = await github.rest.actions.listWorkflowRunsForRepo({ owner, repo, head_sha: sha, per_page: 1 });
  return runs.total_count > 0;
}

async function waitForCi(github, owner, repo, sha, { timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ciStarted(github, owner, repo, sha)) return true;
    if (Date.now() + intervalMs > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function publish({ github, context, core, number, timeoutMs = 10 * 60 * 1000, intervalMs = 20 * 1000, open = openPr }) {
  const { owner, repo } = context.repo;
  const { data: original } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  const result = await open({
    github, context, core,
    branch: `${original.head.ref}-v2`,
    title: original.title,
    body: v2Body(original.body, number),
    baseBranch: original.base.ref,
    labels: v2Labels(original.labels),
    // The sweep's merge-on-green merges the v2; native auto-merge stays off.
    autoMerge: false,
  });
  if (!result.opened) {
    core.setFailed('conflict fix: no changes to publish; the original stays open');
    return { closed: false };
  }
  const v2 = result.pr;
  if (!(await waitForCi(github, owner, repo, v2.head.sha, { timeoutMs, intervalMs }))) {
    core.setFailed(`conflict fix: CI never started on #${v2.number}; #${number} stays open`);
    return { closed: false, v2: v2.number };
  }
  await github.rest.issues.createComment({ owner, repo, issue_number: number, body: `Superseded by #${v2.number}.` });
  await github.rest.pulls.update({ owner, repo, pull_number: number, state: 'closed' });
  core.info(`#${number} closed; superseded by #${v2.number}`);
  return { closed: true, v2: v2.number };
}

module.exports = async ({ github, context, core }) => {
  const number = parseInt(process.env.PR_NUMBER, 10);
  if (isNaN(number)) {
    core.setFailed('PR_NUMBER is not a valid number');
    return;
  }
  await publish({ github, context, core, number });
};
module.exports.v2Body = v2Body;
module.exports.v2Labels = v2Labels;
module.exports.waitForCi = waitForCi;
module.exports.publish = publish;
