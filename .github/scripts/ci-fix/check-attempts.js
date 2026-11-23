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
  // Two attempts per pull request per day and fixer version, so a pull request an older fixer gave up on is tried
  // again by a newer one. Across versions, four attempts a day may end without a published fix: an attempt that
  // committed a fix does not count there. A marker or commit with no timestamp counts as recent.
  const version = process.env.FIXER_VERSION || '';
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = comments.filter(c => c.body && c.body.includes(marker)
    && !(Date.parse(c.created_at || '') < dayAgo));
  const attempts = recent.filter(c => !version || c.body.includes(`<!-- ci-fix-version:${version} -->`)).length;
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber,
    per_page: 100
  });
  const published = commits.filter(c => (c.commit?.message || '').startsWith('fix: resolve CI failure (auto-fix attempt')
    && !(Date.parse(c.commit.committer?.date || '') < dayAgo)).length;
  const unpublished = Math.max(0, recent.length - published);
  core.info(`Last 24 hours: ${attempts} attempts by this fixer version, ${recent.length} in all, ${published} published a fix`);
  if (attempts >= 2 || unpublished >= 4) {
    core.info('Max attempts reached, skipping');
    core.setOutput('should_run', 'false');
    core.setOutput('attempt', attempts.toString());
  } else {
    core.setOutput('should_run', 'true');
    core.setOutput('attempt', (attempts + 1).toString());
  }
};
