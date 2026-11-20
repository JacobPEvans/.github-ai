// Fail the conflict run unless every file the agent's patch changes is one the original pull request changed.
// An empty patch fails too. Reads agent.patch from the working directory and CHANGED_FILES (one path per line).

const fs = require('node:fs');

function patchFiles(patch) {
  const files = new Set();
  for (const line of patch.split('\n')) {
    const match = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
    if (match) {
      files.add(match[1]);
      files.add(match[2]);
    }
  }
  return [...files];
}

function subsetRefusal(patch, changedFiles) {
  const touched = patchFiles(patch);
  if (!touched.length) return 'the agent patch is empty';
  const allowed = new Set(changedFiles);
  const extra = touched.filter((file) => !allowed.has(file));
  if (extra.length) return `the agent patch changes files the original pull request does not: ${extra.join(', ')}`;
  return '';
}

module.exports = async ({ core }) => {
  const patch = fs.existsSync('agent.patch') ? fs.readFileSync('agent.patch', 'utf8') : '';
  const changed = (process.env.CHANGED_FILES || '').split('\n').map((file) => file.trim()).filter(Boolean);
  const reason = subsetRefusal(patch, changed);
  if (reason) {
    core.setFailed(`conflict fix refused: ${reason}`);
    return;
  }
  core.info(`agent patch changes ${patchFiles(patch).length} files, all in the original pull request`);
};
module.exports.patchFiles = patchFiles;
module.exports.subsetRefusal = subsetRefusal;
