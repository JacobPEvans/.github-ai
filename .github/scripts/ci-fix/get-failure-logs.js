module.exports = async ({ github, context, core }) => {
  let runId = process.env.FAILURE_RUN_ID || context.payload.workflow_run?.id;
  if (!runId) {
    // Label-triggered runs carry no failed run: use the newest failed run on
    // the PR head branch instead.
    const branch = process.env.FAILURE_HEAD_BRANCH;
    if (!branch) {
      core.setFailed('FAILURE_RUN_ID is required');
      return;
    }
    const { data } = await github.rest.actions.listWorkflowRunsForRepo({
      owner: context.repo.owner,
      repo: context.repo.repo,
      branch,
      status: 'failure',
      per_page: 1,
    });
    const latest = data.workflow_runs[0];
    if (!latest) {
      core.setFailed(`No failed CI run found for branch ${branch}`);
      return;
    }
    runId = latest.id;
    core.info(`Using the most recent failed run ${latest.id} (${latest.name}) on branch ${branch}`);
  }
  const allJobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: runId
  });
  let logs = '';
  for (const job of allJobs.filter(j => j.conclusion === 'failure')) {
    logs += `\n=== FAILED JOB: ${job.name} ===\n`;
    try {
      const logData = await github.rest.actions.downloadJobLogsForWorkflowRun({
        owner: context.repo.owner,
        repo: context.repo.repo,
        job_id: job.id
      });
      const logLines = logData.data.split('\n');
      logs += logLines.slice(-200).join('\n');
    } catch (e) {
      logs += `(Could not download logs: ${e.message})\n`;
    }
  }
  const truncated = logs.length > 60000 ? logs.slice(-60000) : logs;
  core.setOutput('logs', truncated);
};
