// A failed AI review gate ('<Name> review / Policy gate') writes its findings only to its sticky pull request comment.
// That comment becomes agent input, so it is taken only when the gate's own bot wrote it and it starts with the gate's
// marker, and it is capped.
const GATE_JOB = /\b(\w+) review \/ Policy gate$/i;
const GATE_AUTHOR = 'github-actions[bot]';
const FINDINGS_MAX = 8000;
const DESCRIPTION_MAX = 20000;

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
  // The review reads the description, so the agent gets it too: a finding may be about the description alone.
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  const description = (pr.body || '').slice(0, DESCRIPTION_MAX);
  return `\n=== FINDINGS: ${rubric} review (pull request comment) ===\n${body}\n`
    + `\n=== PULL REQUEST DESCRIPTION (base branch ${pr.base.ref}) ===\n${description}\n`;
}

// Jobs that failed in other runs at the same head, by name, with the pull request title: a known failure class
// can fix one of them without its log (a title check has no file to fix).
async function otherFailures(github, context, runId) {
  const { owner, repo } = context.repo;
  const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
  const { data } = await github.rest.actions.listWorkflowRunsForRepo({
    owner, repo, head_sha: run.head_sha, status: 'failure', per_page: 20,
  });
  const names = [];
  for (const other of (data.workflow_runs || []).filter((r) => String(r.id) !== String(runId))) {
    const { data: jobs } = await github.rest.actions.listJobsForWorkflowRun({ owner, repo, run_id: other.id, per_page: 100 });
    for (const job of (jobs.jobs || []).filter((j) => j.conclusion === 'failure')) names.push(`${other.name} / ${job.name}`);
  }
  if (!names.length) return '';
  const number = run.pull_requests?.[0]?.number;
  const title = number ? (await github.rest.pulls.get({ owner, repo, pull_number: number })).data.title : '';
  return `\n=== OTHER JOBS FAILING AT THIS HEAD (no logs) ===\n${[...new Set(names)].map((n) => `- ${n}`).join('\n')}\n`
    + (title ? `\n=== PULL REQUEST TITLE ===\n${title}\n` : '');
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
  try {
    logs += await otherFailures(github, context, runId);
  } catch (e) {
    core.info(`other failing jobs not listed: ${e.message}`);
  }
  const truncated = logs.length > 60000 ? logs.slice(-60000) : logs;
  core.setOutput('logs', truncated);
};
