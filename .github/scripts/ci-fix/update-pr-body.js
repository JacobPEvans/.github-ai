// Replace the pull request description, and its title, with what the agent wrote, when it wrote one.
const { existsSync, readFileSync } = require('node:fs');

const BODY_MAX = 60000; // under GitHub's 65,536-character limit

module.exports = async ({ github, context, core }) => {
  const file = process.env.PR_BODY_FILE;
  if (!file || !existsSync(file)) return;
  let body = readFileSync(file, 'utf8').trim();
  // A first line 'Title: <text>' retitles the pull request and is not part of the description.
  const titled = /^Title: *(\S.{0,199})(?:\n|$)/.exec(body);
  // Major releases are human-only: a title that marks a breaking change is not applied.
  const title = titled && !/^[a-z]+(\([^)]*\))?!:/.test(titled[1]) ? titled[1].trim() : '';
  if (titled) body = body.slice(titled[0].length).trim();
  if (body.length > BODY_MAX) {
    core.info(`agent description is ${body.length} characters; not applied`);
    body = '';
  }
  if (!body && !title) return;
  const { owner, repo } = context.repo;
  await github.rest.pulls.update({
    owner, repo, pull_number: Number(process.env.PR_NUMBER), ...(title && { title }), ...(body && { body }),
  });
  core.info(`pull request ${[title && 'title', body && 'description'].filter(Boolean).join(' and ')} updated`);
};
