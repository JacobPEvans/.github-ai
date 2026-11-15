module.exports = async ({ github, context, core }) => {
  let runId = process.env.FAILURE_RUN_ID || context.payload.workflow_run?.id;
  if (!runId) {
    // Label-triggered runs carry no failed run: use the newest failed gate run
    // on the PR head sha, never this fixer's own runs; prefer a "CI Gate" run.
    const branch = process.env.FAILURE_HEAD_BRANCH;
    const headSha = process.env.FAILURE_HEAD_SHA;
    if (!branch || !headSha) {
      core.setFailed('FAILURE_RUN_ID is required');
      return;
    }
    const current = await github.rest.actions.getWorkflowRun({
      owner: context.repo.owner,
      repo: context.repo.repo,
      run_id: context.runId,
    });
    const { data } = await github.rest.actions.listWorkflowRunsForRepo({
      owner: context.repo.owner,
      repo: context.repo.repo,
      head_sha: headSha,
      status: 'failure',
      per_page: 50,
    });
    const candidates = data.workflow_runs.filter((run) => run.workflow_id !== current.data.workflow_id);
    const latest = candidates.find((run) => run.name && run.name.includes('CI Gate')) || candidates[0];
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
