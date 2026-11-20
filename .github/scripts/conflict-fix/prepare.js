// Read the conflicted pull request and refuse anything the conflict fix must not touch.
//
// Refused: a pull request that is not open, not conflicted (mergeable_state `dirty`, retried while `unknown`),
// from a fork, already a v2 (head ref ending in -v2, or a body line `Supersedes #N`), or whose `<head>-v2` branch
// exists. At most one v2 per original. Writes head_ref, base_ref, title, body and changed_files for the later jobs.

const UNKNOWN_RETRIES = 5;
const V2_BODY = /^Supersedes #\d+\b/m;

function refusal(pr, v2Exists) {
  if (pr.state !== 'open') return `pull request #${pr.number} is ${pr.state}`;
  if (!pr.head.repo || pr.head.repo.full_name !== pr.base.repo.full_name) return 'the head is a fork';
  if (pr.head.ref.endsWith('-v2') || V2_BODY.test(pr.body || '')) return 'the pull request is already a v2';
  if (pr.mergeable_state !== 'dirty') return `the pull request is not conflicted (mergeable_state ${pr.mergeable_state})`;
  if (v2Exists) return `branch ${pr.head.ref}-v2 already exists`;
  return '';
}

async function readPr(github, owner, repo, number, delayMs) {
  let pr;
  for (let attempt = 0; attempt <= UNKNOWN_RETRIES; attempt += 1) {
    ({ data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number }));
    if (pr.mergeable_state !== 'unknown') break;
    if (attempt < UNKNOWN_RETRIES) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return pr;
}

async function branchExists(github, owner, repo, branch) {
  try {
    await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

async function prepare({ github, context, core, number, delayMs = 5000 }) {
  const { owner, repo } = context.repo;
  const pr = await readPr(github, owner, repo, number, delayMs);
  const v2Exists = await branchExists(github, owner, repo, `${pr.head.ref}-v2`);
  const reason = refusal(pr, v2Exists);
  if (reason) {
    core.setFailed(`conflict fix refused: ${reason}`);
    return { ok: false, reason };
  }
  const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 });
  const changed = files.map((file) => file.filename);
  core.setOutput('head_ref', pr.head.ref);
  core.setOutput('base_ref', pr.base.ref);
  core.setOutput('title', pr.title);
  core.setOutput('body', pr.body || '');
  core.setOutput('changed_files', changed.join('\n'));
  core.info(`conflict fix for #${number}: ${pr.head.ref} onto ${pr.base.ref}, ${changed.length} changed files`);
  return { ok: true, changed };
}

module.exports = async ({ github, context, core }) => {
  const number = parseInt(process.env.PR_NUMBER, 10);
  if (isNaN(number)) {
    core.setFailed('PR_NUMBER is not a valid number');
    return;
  }
  await prepare({ github, context, core, number });
};
module.exports.refusal = refusal;
module.exports.prepare = prepare;
