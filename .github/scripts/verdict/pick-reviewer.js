const fs = require('fs');
const { noModelBots } = require('../shared/constants.js');

module.exports = async ({ github, context, core }) => {
  const prNumber = parseInt(process.env.PR_NUMBER, 10);
  const headSha = process.env.HEAD_SHA;
  const prAuthor = process.env.PR_AUTHOR;
  const familiesFile = process.env.FAMILIES_FILE;
  const visibility = process.env.VISIBILITY;
  const served = new Set((process.env.ROUTER_MODELS || '').split('\n').map((name) => name.trim()).filter(Boolean));
  const { families, reviewers, alias_families: aliasFamilies } = JSON.parse(fs.readFileSync(familiesFile, 'utf8'));
  if (visibility !== 'public' && visibility !== 'private') {
    core.setFailed(`VISIBILITY must be public or private, not "${visibility}".`);
    return;
  }

  if (noModelBots.includes(prAuthor)) {
    core.setOutput('skip', 'true');
    core.setOutput('model', '');
    core.setOutput('family', '');
    core.info(`Author ${prAuthor} has no model; skipping review.`);
    return;
  }

  const pr = (await github.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber,
  })).data;
  if (pr.head.sha !== headSha) {
    core.setFailed(`The pull request head moved from ${headSha.slice(0, 7)} to ${pr.head.sha.slice(0, 7)}; this run reviews nothing.`);
    return;
  }

  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const authorFamilies = new Set();
  for (const commit of commits) {
    if (Array.isArray(commit.parents) && commit.parents.length > 1) {
      continue;
    }
    const message = commit.commit && commit.commit.message;
    const trailerRe = /^Assisted-by:\s*(.+)$/gim;
    const trailers = [];
    let match;
    while ((match = trailerRe.exec(message)) !== null) {
      trailers.push(match[1].trim());
    }
    if (trailers.length === 0) {
      core.setFailed(`Commit ${commit.sha.slice(0, 7)} has no Assisted-by trailer; the author model is unknown.`);
      return;
    }
    for (const value of trailers) {
      const lower = value.toLowerCase();
      const family = Object.entries(families).find(([, keywords]) =>
        keywords.some((keyword) => lower.includes(keyword))
      );
      if (!family) {
        core.setFailed(`Unknown model family in trailer "${value}" on commit ${commit.sha.slice(0, 7)}.`);
        return;
      }
      authorFamilies.add(family[0]);
    }
  }

  // A reviewer must be listed for every author family, keep the first family's
  // order, and be served by the router for this key.
  const [first, ...rest] = [...authorFamilies].sort().map((family) => reviewers[family][visibility]);
  const alias = first.find((name) => rest.every((list) => list.includes(name)) && served.has(name));
  const authors = [...authorFamilies].sort().join(',');
  if (!alias) {
    core.setFailed(`No reviewer of another family is served (author families ${authors}, ${visibility} repository).`);
    return;
  }

  core.setOutput('skip', 'false');
  core.setOutput('model', alias);
  core.setOutput('family', aliasFamilies[alias]);
  core.setOutput('author_families', authors);
  core.info(`Author families ${authors}; assigned reviewer ${alias} (${aliasFamilies[alias]}).`);
};
