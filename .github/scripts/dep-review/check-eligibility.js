// Gate for cc-dep-review: run Claude once per Renovate dependency PR whose
// highest semver update type is in UPDATE_TYPES. Digest pins, lock-file
// maintenance, and anything already reviewed (dedup marker) never reach the
// paid Claude job.
const MARKER = '<!-- cc-dep-review -->';
const RANK = { major: 3, minor: 2, patch: 1 };

function dependabotTypes(pr) {
  const types = [];
  const text = `${pr.title || ''}\n${pr.body || ''}`;
  for (const match of text.matchAll(/\bfrom\s+`?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?`?\s+to\s+`?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/gi)) {
    const old = match.slice(1, 4).map((v) => Number(v || 0));
    const next = match.slice(4, 7).map((v) => Number(v || 0));
    const index = old.findIndex((v, i) => v !== next[i]);
    if (index >= 0) types.push(['major', 'minor', 'patch'][index]);
  }
  return types;
}

// Renovate PR bodies carry a table whose Update column holds the bump type.
// Only table rows are scanned so prose/release notes can't false-match.
function parseUpdateTypes(body) {
  const types = new Set();
  for (const line of (body || '').split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const match = line.match(/\|\s*(major|minor|patch|digest|pin|pinDigest|lockFileMaintenance)\s*\|/i);
    if (match) types.add(match[1].toLowerCase());
  }
  return [...types];
}

function highestSemverType(types) {
  return types.filter((t) => RANK[t]).sort((a, b) => RANK[b] - RANK[a])[0] || null;
}

module.exports = async ({ github, context, core }) => {
  const skip = (message) => {
    core.setOutput('should_run', 'false');
    core.info(message);
  };

  const pr = context.payload.pull_request;
  if (!pr) return skip('No pull_request payload — skipping');

  const authors = (process.env.BOT_AUTHORS || 'renovate[bot],dependabot[bot]').split(',').map((s) => s.trim());
  const login = pr.user && pr.user.login;
  if (!authors.includes(login)) return skip(`PR author "${login}" is not a dependency bot — skipping`);

  const requireLabel = process.env.REQUIRE_LABEL || '';
  if (requireLabel && !(pr.labels || []).some((l) => l.name === requireLabel)) {
    return skip(`PR lacks required label "${requireLabel}" — skipping`);
  }

  const updateTypes = (process.env.UPDATE_TYPES || 'major,minor')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const found = login === 'dependabot[bot]' ? dependabotTypes(pr) : parseUpdateTypes(pr.body);
  const top = highestSemverType(found);
  if (!top) return skip(`No semver update type in the Renovate table (found: ${found.join(', ') || 'none'}) — skipping`);
  if (!updateTypes.includes(top)) return skip(`Update type "${top}" not in [${updateTypes.join(', ')}] — skipping`);

  const { owner, repo } = context.repo;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const headMarker = pr.head?.sha && `<!-- cc-dep-review-head:${pr.head.sha} -->`;
  if (headMarker && comments.some((c) => c.body?.includes(MARKER) && c.body.includes(headMarker))) {
    return skip('cc-dep-review comment already present — skipping');
  }

  core.setOutput('should_run', 'true');
  core.setOutput('pr_number', String(pr.number));
  core.setOutput('update_type', top);
  core.info(`PR #${pr.number} eligible — update_type=${top}`);
};

module.exports.parseUpdateTypes = parseUpdateTypes;
module.exports.highestSemverType = highestSemverType;
