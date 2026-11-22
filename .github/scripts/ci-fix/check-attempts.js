module.exports = async ({ github, context, core }) => {
  const prNumber = parseInt(process.env.PR_NUMBER, 10);
  if (isNaN(prNumber)) {
    core.setFailed('PR_NUMBER is not a valid number');
    return;
  }
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: prNumber,
    per_page: 100
  });
  const marker = '<!-- claude-ci-fix-attempt -->';
  // Two attempts per pull request per day: a marker with no timestamp counts as recent.
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const attempts = comments.filter(c => c.body && c.body.includes(marker)
    && !(Date.parse(c.created_at || '') < dayAgo)).length;
  core.info(`Found ${attempts} fix attempts in the last 24 hours`);
  if (attempts >= 2) {
    core.info('Max attempts reached, skipping');
    core.setOutput('should_run', 'false');
    core.setOutput('attempt', attempts.toString());
  } else {
    core.setOutput('should_run', 'true');
    core.setOutput('attempt', (attempts + 1).toString());
  }
};
