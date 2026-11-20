// A failed AI review gate ('<Name> review / Policy gate') writes its findings only to its sticky pull request comment.
// That comment becomes agent input, so it is taken only when the gate's own bot wrote it and it starts with the gate's
// marker, and it is capped.
const GATE_JOB = /\b(\w+) review \/ Policy gate$/i;
const GATE_AUTHOR = 'github-actions[bot]';
const FINDINGS_MAX = 8000;

async function gateFindings(github, context, runId, rubric) {
  const { owner, repo } = context.repo;
  const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
  const number = run.pull_requests?.[0]?.number;
  if (!number) return '';
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 });
  const marker = `<!-- ${rubric.toLowerCase()}-review -->`;
  const comment = comments.find((c) => c.user?.login === GATE_AUTHOR && (c.body || '').startsWith(marker));
  if (!comment) return '';
  const body = comment.body.length > FINDINGS_MAX
    ? `${comment.body.slice(0, FINDINGS_MAX)}\n(findings truncated at ${FINDINGS_MAX} characters)`
    : comment.body;
  return `\n=== FINDINGS: ${rubric} review (pull request comment) ===\n${body}\n`;
}

module.exports = async ({ github, context, core }) => {
  const runId = process.env.FAILURE_RUN_ID || context.payload.workflow_run?.id;
  if (!runId) {
    core.setFailed('FAILURE_RUN_ID is required');
    return;
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
    const gate = GATE_JOB.exec(job.name || '');
    if (gate) {
      try {
        logs += await gateFindings(github, context, runId, gate[1]);
      } catch (e) {
        logs += `(Could not read the review findings: ${e.message})\n`;
      }
    }
  }
  const truncated = logs.length > 60000 ? logs.slice(-60000) : logs;
  core.setOutput('logs', truncated);
};
