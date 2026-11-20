// Fail the conflict run unless the agent's patch is publishable: not empty, no rename or copy, nothing under
// .github/, and every file it changes is one the original pull request changed. Reads agent.patch from the working
// directory and CHANGED_FILES (one path per line).
//
// Paths come from `git apply --numstat -z`: NUL-separated and unquoted, so a path with a space or a non-ASCII byte
// (quoted in a `diff --git` header) is checked as written. `git apply` reports only the new name of a rename, so the
// patch is collected with --no-renames (a rename is a delete plus an add) and any rename or copy left is refused.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// `added<TAB>deleted<TAB>path<NUL>`; an empty path is followed by `old<NUL>new<NUL>` (the git diff rename form).
function numstatPaths(output) {
  const tokens = output.split('\0');
  const paths = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const match = tokens[i].match(/^[^\t]*\t[^\t]*\t(.*)$/s);
    if (!match) continue;
    if (match[1] === '') {
      paths.push(tokens[i + 1], tokens[i + 2]);
      i += 2;
    } else {
      paths.push(match[1]);
    }
  }
  return [...new Set(paths.filter(Boolean))];
}

function subsetRefusal({ paths, summary }, changedFiles) {
  if (!paths.length) return 'the agent patch is empty';
  if (/^ (rename|copy) /m.test(summary)) return 'the agent patch renames or copies a file';
  const github = paths.filter((path) => path === '.github' || path.startsWith('.github/'));
  if (github.length) return `the agent patch edits .github/: ${github.join(', ')}`;
  const allowed = new Set(changedFiles);
  const extra = paths.filter((path) => !allowed.has(path));
  if (extra.length) return `the agent patch changes files the original pull request does not: ${extra.join(', ')}`;
  return '';
}

function readPatch(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return { paths: [], summary: '' };
  const git = (flag) => execFileSync('git', ['apply', flag, '-z', file], { encoding: 'utf8' });
  return { paths: numstatPaths(git('--numstat')), summary: git('--summary') };
}

module.exports = async ({ core }) => {
  const changed = (process.env.CHANGED_FILES || '').split('\n').map((file) => file.trim()).filter(Boolean);
  const patch = readPatch('agent.patch');
  const reason = subsetRefusal(patch, changed);
  if (reason) {
    core.setFailed(`conflict fix refused: ${reason}`);
    return;
  }
  core.info(`agent patch changes ${patch.paths.length} files, all in the original pull request`);
};
module.exports.numstatPaths = numstatPaths;
module.exports.subsetRefusal = subsetRefusal;
module.exports.readPatch = readPatch;
