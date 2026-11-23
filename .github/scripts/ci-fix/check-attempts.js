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
  // Two attempts per pull request per day and fixer version, six per day in all, so a pull request an older
  // fixer gave up on is tried again by a newer one. A marker with no timestamp counts as recent.
  const version = process.env.FIXER_VERSION || '';
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = comments.filter(c => c.body && c.body.includes(marker)
    && !(Date.parse(c.created_at || '') < dayAgo));
  const attempts = recent.filter(c => !version || c.body.includes(`<!-- ci-fix-version:${version} -->`)).length;
  core.info(`Found ${attempts} fix attempts by this fixer version, ${recent.length} in all, in the last 24 hours`);
  if (attempts >= 2 || recent.length >= 6) {
    core.info('Max attempts reached, skipping');
    core.setOutput('should_run', 'false');
    core.setOutput('attempt', attempts.toString());
  } else {
    core.setOutput('should_run', 'true');
    core.setOutput('attempt', (attempts + 1).toString());
  }
};
