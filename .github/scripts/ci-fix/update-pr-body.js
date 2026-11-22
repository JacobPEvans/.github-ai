// Replace the pull request description with the one the agent wrote, when it wrote one.
const { existsSync, readFileSync } = require('node:fs');

const BODY_MAX = 60000; // under GitHub's 65,536-character limit

module.exports = async ({ github, context, core }) => {
  const file = process.env.PR_BODY_FILE;
  if (!file || !existsSync(file)) return;
  const body = readFileSync(file, 'utf8').trim();
  if (!body || body.length > BODY_MAX) {
    core.info(`agent description is ${body.length} characters; not applied`);
    return;
  }
  const { owner, repo } = context.repo;
  await github.rest.pulls.update({ owner, repo, pull_number: Number(process.env.PR_NUMBER), body });
  core.info('pull request description updated');
};
