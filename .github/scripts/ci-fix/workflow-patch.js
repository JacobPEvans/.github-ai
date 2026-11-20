// Decide whether an agent patch that edits .github/ may be published as a workflow fix.
//
// Allowed only when every rule holds: the failed run has a failed workflow-class job (workflow policy or workflow
// lint); every .github/ path in the patch is an existing file under .github/workflows/ that the pull request already
// changes; and the patch adds no new `uses:` reference, no new `secrets.` reference and no new permission grant.
// Writes workflow_fix=true|false, reason and the pull request's base_ref. A patch without .github/ paths gets workflow_fix=false, reason=none.

const fs = require('node:fs');

const WORKFLOW_CLASS = /workflow policy|workflow lint|actionlint/i;
const USES = /^\s*-?\s*uses:\s*['"]?([^\s'"#]+)/;
const SECRET = /secrets\.[A-Za-z0-9_]+/g;
const GRANT = /^\s*(permissions\s*:.*|[a-z-]+\s*:\s*(read|write|none|read-all|write-all))\s*$/;

function stripComment(line) {
  return line.replace(/\s+#.*$/, '').trim();
}

// Per file: its paths, whether it is new or deleted, and the lines it adds and removes.
function parsePatch(patch) {
  const files = [];
  let file;
  for (const line of patch.split('\n')) {
    const header = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
    if (header) {
      file = { from: header[1], to: header[2], created: false, deleted: false, added: [], removed: [] };
      files.push(file);
    } else if (!file) {
      continue;
    } else if (line.startsWith('new file mode') || line.startsWith('deleted file mode')) {
      file[line.startsWith('new') ? 'created' : 'deleted'] = true;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      file.added.push(line.slice(1));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      file.removed.push(line.slice(1));
    }
  }
  return files;
}

function introduced(added, removed, pick) {
  const before = new Set(removed.flatMap(pick));
  return added.flatMap(pick).filter((item) => !before.has(item));
}

const usesRefs = (line) => { const m = line.match(USES); return m ? [m[1]] : []; };
const secretRefs = (line) => line.match(SECRET) || [];
const grants = (line) => { const s = stripComment(line); return GRANT.test(s) ? [s] : []; };

function diffRefusal(files) {
  for (const file of files) {
    const uses = introduced(file.added, file.removed, usesRefs);
    if (uses.length) return `new uses reference in ${file.to}: ${uses[0]}`;
    const secrets = introduced(file.added, file.removed, secretRefs);
    if (secrets.length) return `new secrets reference in ${file.to}: ${secrets[0]}`;
    const granted = introduced(file.added, file.removed, grants);
    if (granted.length) return `permission change in ${file.to}: ${granted[0]}`;
  }
  return '';
}

async function decide({ github, context, patch, prNumber, runId }) {
  const github_files = parsePatch(patch).filter((f) => f.from.startsWith('.github/') || f.to.startsWith('.github/'));
  if (!github_files.length) return { allowed: false, reason: 'none' };
  const outside = github_files.find((f) => !f.to.startsWith('.github/workflows/') || f.from !== f.to);
  if (outside) return { allowed: false, reason: `not a workflow file edit: ${outside.to}` };
  const shape = github_files.find((f) => f.created || f.deleted);
  if (shape) return { allowed: false, reason: `creates or deletes ${shape.to}` };

  const { owner, repo } = context.repo;
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, { owner, repo, run_id: runId, per_page: 100 });
  if (!jobs.some((job) => job.conclusion === 'failure' && WORKFLOW_CLASS.test(job.name))) {
    return { allowed: false, reason: 'the failed run has no failed workflow-class job' };
  }
  const changed = new Set((await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: prNumber, per_page: 100 }))
    .map((f) => f.filename));
  const unchanged = github_files.find((f) => !changed.has(f.to));
  if (unchanged) return { allowed: false, reason: `the pull request does not change ${unchanged.to}` };
  const refusal = diffRefusal(github_files);
  if (refusal) return { allowed: false, reason: refusal };
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  return { allowed: true, reason: 'workflow fix', baseRef: pr.base.ref };
}

module.exports = async ({ github, context, core }) => {
  const prNumber = parseInt(process.env.PR_NUMBER, 10);
  const runId = parseInt(process.env.FAILURE_RUN_ID, 10);
  const patch = fs.existsSync('agent.patch') ? fs.readFileSync('agent.patch', 'utf8') : '';
  let result = { allowed: false, reason: 'none' };
  if (patch && (isNaN(prNumber) || isNaN(runId))) result = { allowed: false, reason: 'missing PR number or run id' };
  else if (patch) result = await decide({ github, context, patch, prNumber, runId });
  core.info(`workflow fix: ${result.allowed} (${result.reason})`);
  core.setOutput('workflow_fix', String(result.allowed));
  core.setOutput('reason', result.reason);
  core.setOutput('base_ref', result.baseRef || '');
};
module.exports.parsePatch = parsePatch;
module.exports.diffRefusal = diffRefusal;
module.exports.decide = decide;
