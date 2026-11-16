module.exports = async ({ github, context, core }) => {
  const prNumber = parseInt(process.env.PR_NUMBER, 10);
  if (isNaN(prNumber)) {
    core.setFailed('PR_NUMBER is not a valid number');
    return;
  }
  let data;
  try {
    data = (await github.rest.pulls.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber,
    })).data;
  } catch (error) {
    if (error.status === 404) {
      core.info(`PR #${prNumber} not found; dropping the fix`);
      core.setOutput('open', 'false');
      return;
    }
    throw error;
  }
  if (data.state === 'open') {
    core.setOutput('open', 'true');
    return;
  }
  core.info(`PR #${prNumber} is ${data.state}; dropping the fix`);
  core.setOutput('open', 'false');
};
