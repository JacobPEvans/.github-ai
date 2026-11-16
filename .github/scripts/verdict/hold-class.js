const fs = require('fs');

// Classifies a pull request as hold class when a changed path matches the
// shared list or it carries a hold label. A hold-class pull request needs the
// repository's `hold` Environment with required reviewers; without one this
// fails instead of letting GitHub create an unprotected Environment.
// Env: PR_NUMBER, HOLD_FILE.
module.exports = async ({ github, context, core }) => {
  const prNumber = parseInt(process.env.PR_NUMBER, 10);
  const { labels, paths } = JSON.parse(fs.readFileSync(process.env.HOLD_FILE, 'utf8'));
  const rules = paths.map(({ class: cls, pattern }) => ({ cls, re: new RegExp(pattern, 'i') }));
  const repo = { owner: context.repo.owner, repo: context.repo.repo };

  // Labels are read live, so a label added after the last push counts on a re-run.
  const pr = (await github.rest.pulls.get({ ...repo, pull_number: prNumber })).data;
  const holdLabels = pr.labels.map(({ name }) => name).filter((name) => labels.includes(name));

  const files = await github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: prNumber, per_page: 100 });
  const matches = [];
  for (const file of files) {
    for (const name of [file.filename, file.previous_filename].filter(Boolean)) {
      const rule = rules.find(({ re }) => re.test(name));
      if (rule) matches.push(`${name} (${rule.cls})`);
    }
  }

  const hold = holdLabels.length > 0 || matches.length > 0;
  if (hold) {
    let reviewers = 0;
    try {
      const env = (await github.rest.repos.getEnvironment({ ...repo, environment_name: 'hold' })).data;
      const rule = (env.protection_rules ?? []).find(({ type }) => type === 'required_reviewers');
      reviewers = rule?.reviewers?.length ?? 0;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (reviewers === 0) {
      core.setFailed('This pull request is hold class, but the repository has no hold Environment with required reviewers.');
      return;
    }
  }

  const reasons = [...holdLabels.map((name) => `label ${name}`), ...matches];
  core.info(hold ? `Hold class: ${reasons.join(', ')}` : 'Not hold class.');
  core.setOutput('hold', String(hold));
};
