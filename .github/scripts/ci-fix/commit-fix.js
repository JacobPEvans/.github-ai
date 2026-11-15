// Commit Claude's working-tree changes to the failing PR's branch. Thin wrapper
// over the shared verified-commit helper (App-token createCommitOnBranch →
// GitHub-VERIFIED, satisfies required_signatures, re-triggers CI). See
// shared/verified-commit.js and docs/PATTERNS.md "Verified Commit & PR Pattern".
const { commitToBranch } = require('../shared/verified-commit.js');

// A PR sitting in a merge queue must not receive pushes: the commit would
// invalidate (or dequeue) the queued entry the gate is evaluating. Read the
// entry through GraphQL immediately before the commit so the check races the
// push as little as possible.
const MERGE_QUEUE_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        mergeQueueEntry { state }
      }
    }
  }
`;

module.exports = async ({ github, context, core }) => {
  const prNumber = parseInt(process.env.PR_NUMBER, 10);
  if (Number.isSafeInteger(prNumber) && prNumber > 0) {
    const res = await github.graphql(MERGE_QUEUE_QUERY, {
      owner: context.repo.owner,
      name: context.repo.repo,
      number: prNumber,
    });
    const entry = res.repository?.pullRequest?.mergeQueueEntry;
    if (entry) {
      core.notice(`PR #${prNumber} is in the merge queue (${entry.state}) — skipping the push.`);
      core.setOutput('committed', 'false');
      return { committed: false };
    }
  }
  await commitToBranch({
    github,
    context,
    core,
    branch: process.env.HEAD_BRANCH,
    message: process.env.COMMIT_MESSAGE,
    // Comma-separated workspace paths the caller wrote and must not commit.
    extraExcludes: (process.env.EXTRA_EXCLUDES || '').split(',').map((p) => p.trim()).filter(Boolean),
  });
};
