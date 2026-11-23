// Hands a CI fix the publisher held back (stop-github-patch.sh) to a person: one handoff comment per pull request that links the run's
// patch artifact (never the patch body), the human:review label, and the attempt marker voided so it is not counted.
// Env: PR_NUMBER; HANDOFF_REASON, the stop script's reason (defaults to the .github/ reason).
const MARKER = '<!-- ci-fix-handoff -->';
const ATTEMPT = '<!-- claude-ci-fix-attempt -->';
const LABEL = 'human:review';

module.exports = async ({ github, context, core }) => {
  const prNumber = Number(process.env.PR_NUMBER);
  if (!prNumber) {
    core.setFailed('PR_NUMBER is not a valid number');
    return;
  }
  const reason = process.env.HANDOFF_REASON || 'The proposed fix edits files under `.github/`';
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const runUrl = `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  const body = [
    MARKER,
    `> **CI fix handed off.** ${reason}, which this workflow does not commit.`,
    `> The patch is in the \`ci-fix-${context.runId}\` artifact of [this run](${runUrl}). Not counted as an attempt.`,
  ].join('\n');

  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: prNumber, per_page: 100 });
  const bot = comments.filter((c) => c.user?.type === 'Bot');
  const existing = bot.find((c) => c.body?.startsWith(MARKER));
  if (existing) {
    await github.rest.issues.updateComment({ ...repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ ...repo, issue_number: prNumber, body });
  }

  const last = bot.filter((c) => c.body?.includes(ATTEMPT)).pop();
  if (last) {
    const voided = `${last.body.replace(ATTEMPT, '<!-- claude-ci-fix-attempt-void -->')}\n\nNot counted: handed off for human review.`;
    await github.rest.issues.updateComment({ ...repo, comment_id: last.id, body: voided });
  }

  try {
    await github.rest.issues.addLabels({ ...repo, issue_number: prNumber, labels: [LABEL] });
  } catch (error) {
    core.warning(`Could not add the ${LABEL} label: ${error.message}`);
  }
  core.info(`PR #${prNumber}: CI fix handed off for human review`);
};
