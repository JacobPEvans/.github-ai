module.exports = async ({ github, context, core }) => {
  const branch = process.env.FAILURE_HEAD_BRANCH || context.payload.workflow_run?.head_branch;
  if (!branch) {
    core.setFailed('FAILURE_HEAD_BRANCH is required');
    return;
  }
  // A failed merge queue run names the queue branch. The fix belongs on the
  // pull request's own branch, which the queue branch name leads to. Only a
  // merge_group run is read this way, so an ordinary branch with such a name is not.
  const queue = context.payload.workflow_run?.event === 'merge_group'
    && branch.match(/^(?:refs\/heads\/)?gh-readonly-queue\/.+\/pr-([0-9]+)-[0-9a-f]+$/);
  if (queue) {
    const { data: pull } = await github.rest.pulls.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: Number(queue[1]),
    });
    // The later fork guard sees the queue branch's repository, so a fork is refused here.
    const sameRepo = pull.head.repo?.full_name === `${context.repo.owner}/${context.repo.repo}`;
    core.setOutput('head_branch', pull.head.ref);
    core.setOutput('pr_number', pull.state === 'open' && sameRepo ? String(pull.number) : '');
    return;
  }
  core.setOutput('head_branch', branch);
  const { data: prs } = await github.rest.pulls.list({
    owner: context.repo.owner,
    repo: context.repo.repo,
    head: `${context.repo.owner}:${branch}`,
    state: 'open'
  });
  if (prs.length === 0) {
    core.info(`No open PR for branch ${branch}`);
    core.setOutput('pr_number', '');
    return;
  }
  core.setOutput('pr_number', prs[0].number.toString());
};
