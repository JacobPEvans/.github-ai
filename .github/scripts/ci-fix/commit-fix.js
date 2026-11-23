// Commit Claude's working-tree changes to the failing PR's branch. Thin wrapper
// over the shared verified-commit helper (App-token createCommitOnBranch →
// GitHub-VERIFIED, satisfies required_signatures, re-triggers CI). See
// shared/verified-commit.js and docs/PATTERNS.md "Verified Commit & PR Pattern".
const { commitToBranch } = require('../shared/verified-commit.js');

module.exports = async ({ github, context, core }) => {
  // The fix was made from the head the fix job checked out (FIX_BASE_SHA). If
  // the PR branch has moved since, the patch is stale — commit nothing rather
  // than land an unrelated change on top of the new head.
  const fixBaseSha = (process.env.FIX_BASE_SHA || '').trim();
  if (fixBaseSha && process.env.HEAD_BRANCH) {
    const { owner, repo } = context.repo;
    const { data: ref } = await github.rest.git.getRef({ owner, repo, ref: `heads/${process.env.HEAD_BRANCH}` });
    if (ref.object.sha !== fixBaseSha) {
      core.info(`head moved from ${fixBaseSha} to ${ref.object.sha}; fix dropped`);
      return;
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
