// Land the resolution on the original pull request's branch: a merge commit of that branch's head and the base tip
// the agent worked on, whose tree is the checked-out base tip plus the applied agent patch.
//
// The pull request keeps its number, reviews and history. The branch moves forward by one verified commit, with no
// force-push and no replacement pull request. If there is nothing to publish, or the head moved since it was read,
// the run fails and the pull request is left as it was.

const { mergeToBranch } = require('../shared/verified-commit.js');

async function publish({ github, context, core, number, merge = mergeToBranch }) {
  const { owner, repo } = context.repo;
  const { data: original } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  const result = await merge({
    github, context, core,
    branch: original.head.ref,
    headOid: original.head.sha,
    // A conventional subject, which the commit-message rulesets accept.
    message: `chore: merge ${original.base.ref} into ${original.head.ref}`,
  });
  if (!result.merged) {
    core.setFailed(`conflict fix: no changes to publish; #${number} is left as it was`);
    return { merged: false };
  }
  core.info(`#${number}: conflict resolved in ${result.commit.sha}`);
  return { merged: true, sha: result.commit.sha };
}

module.exports = async ({ github, context, core }) => {
  const number = parseInt(process.env.PR_NUMBER, 10);
  if (isNaN(number)) {
    core.setFailed('PR_NUMBER is not a valid number');
    return;
  }
  await publish({ github, context, core, number });
};
module.exports.publish = publish;
