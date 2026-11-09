'use strict';

const fs = require('node:fs');
const path = require('node:path');

function findGhExecutable() {
  const executable = process.env.PATH
    .split(path.delimiter)
    .map(directory => path.join(directory, 'gh'))
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());

  if (!executable) throw new Error('GitHub CLI was not found on PATH.');
  return executable;
}

module.exports = ({ core }) => {
  const runtimeDir = path.join(process.env.RUNNER_TEMP, 'trusted-issue-reader');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'gh'), path.join(runtimeDir, 'gh'));
  fs.copyFileSync(path.join(__dirname, 'authors.js'), path.join(runtimeDir, 'authors.js'));
  fs.writeFileSync(path.join(runtimeDir, 'config.json'), JSON.stringify({ gh: findGhExecutable() }));
  fs.chmodSync(path.join(runtimeDir, 'gh'), 0o755);
  core.addPath(runtimeDir);
};
