const { createHash } = require('node:crypto');

// Matches the legacy `<!-- claude-ci-fix-attempt -->` marker and the keyed
// `<!-- claude-ci-fix-attempt key=<head-sha-12>-<signature> -->` variant.
const MARKER_PREFIX = '<!-- claude-ci-fix-attempt';
const FAILED_CONCLUSIONS = ['failure', 'timed_out', 'cancelled'];

module.exports = async ({ github, context, core }) => {
  const prNumber = parseInt(process.env.PR_NUMBER, 10);
  if (isNaN(prNumber)) {
    core.setFailed('PR_NUMBER is not a valid number');
    return;
  }
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100
  });
  const attempts = comments.filter(c => c.body && c.body.includes(MARKER_PREFIX)).length;
  core.info(`Found ${attempts} previous fix attempts`);

  // Key of this (PR head SHA, failure signature) pair. A repeat of the same
  // pair is skipped; a changed head or signature allows a new attempt.
  let key = '';
  const failureRunId = process.env.FAILURE_RUN_ID;
  if (failureRunId) {
    try {
      const run = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: failureRunId });
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        owner,
        repo,
        run_id: failureRunId,
        filter: 'latest',
        per_page: 100
      });
      const parts = jobs
        .filter(job => FAILED_CONCLUSIONS.includes(job.conclusion))
        .map(job => {
          const failedStep = (job.steps || []).find(step =>
            FAILED_CONCLUSIONS.includes(step.conclusion)
          );
          return `${job.name}::${failedStep ? failedStep.name : ''}`;
        })
        .sort();
      const signature = createHash('sha256')
        .update(parts.join('|'))
        .digest('hex')
        .slice(0, 12);
      key = `${run.data.head_sha.slice(0, 12)}-${signature}`;
    } catch (error) {
      core.warning(`Could not derive the attempt key: ${error && error.message ? error.message : error}`);
    }
  }

  if (key && comments.some(c => c.body && c.body.includes(`key=${key}`))) {
    core.info(`duplicate attempt for ${key}`);
    core.setOutput('should_run', 'false');
    core.setOutput('attempt', attempts.toString());
    core.setOutput('attempt_key', key);
    return;
  }

  if (attempts >= 2) {
    core.info('Max attempts reached, skipping');
    core.setOutput('should_run', 'false');
    core.setOutput('attempt', attempts.toString());
  } else {
    core.setOutput('should_run', 'true');
    core.setOutput('attempt', (attempts + 1).toString());
  }
  core.setOutput('attempt_key', key);
};
