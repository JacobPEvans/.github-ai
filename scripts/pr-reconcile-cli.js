// pr-reconcile command-line entry: runs the reconcile sweep for each owner in
// PR_RECONCILE_OWNERS, outside GitHub Actions. Each owner reads its token from
// PR_RECONCILE_TOKEN_DIR/<owner>. Every line on stdout is one JSON object; each
// owner ends with one `tick` line. The exit code is 1 when any owner failed.

const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');
const { paginateRest } = require('@octokit/plugin-paginate-rest');
const run = require('../.github/scripts/pr-reconcile/reconcile.js');

const Client = Octokit.plugin(paginateRest);
const OWNER_PATTERN = /^[A-Za-z0-9-]+$/;
const DRY_RUN_BLOCKED = 'dry-run-blocked';
// Octokit's own request log would print non-JSON lines to stdout; the CLI logs everything itself.
const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

async function main({ fetch, out = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const log = (obj) => out(JSON.stringify(obj));
  const owners = (process.env.PR_RECONCILE_OWNERS || '').split(',').map((o) => o.trim()).filter(Boolean);
  const dir = process.env.PR_RECONCILE_TOKEN_DIR || '';
  if (!owners.length || !dir) {
    log({ level: 'error', message: 'PR_RECONCILE_OWNERS and PR_RECONCILE_TOKEN_DIR must both be set' });
    return 1;
  }
  const dryRun = process.env.PR_RECONCILE_DRY_RUN === '1';
  delete process.env.PR_NUMBER;
  delete process.env.BASE_REF;
  let failed = false;
  for (const owner of owners) {
    const tick = { event: 'tick', owner, prs: 0, errors: 0, requests: 0, ratelimit_remaining: null, ratelimit_limit: null };
    try {
      if (!OWNER_PATTERN.test(owner)) throw new Error('invalid owner name');
      let token;
      try {
        token = fs.readFileSync(path.join(dir, owner), 'utf8').trim();
      } catch {
        throw new Error('token file is missing or unreadable');
      }
      if (!token) throw new Error('token file is empty');
      const github = new Client({ auth: token, log: QUIET, request: fetch ? { fetch } : {} });
      github.hook.before('request', (options) => {
        if (dryRun && options.method !== 'GET') {
          log({ event: 'dry_run_blocked', owner, method: options.method, route: options.url });
          throw Object.assign(new Error('dry run: request blocked'), { status: DRY_RUN_BLOCKED });
        }
        tick.requests += 1;
      });
      github.hook.after('request', (response) => {
        tick.ratelimit_remaining = response.headers['x-ratelimit-remaining'] ?? null;
        tick.ratelimit_limit = response.headers['x-ratelimit-limit'] ?? null;
      });
      const core = {
        info: (message) => log({ level: 'info', message }),
        warning: (message) => log({ level: 'warning', message }),
        error: (message) => log({ level: 'error', message }),
        setOutput: (name, value) => log({ level: 'output', name, value }),
      };
      process.env.SWEEP_OWNER = owner;
      const events = await run({ github, context: { repo: { owner, repo: '' } }, core });
      tick.prs = events.length;
      tick.errors = events.filter((e) => String(e.outcome).startsWith('error:') && e.outcome !== `error:${DRY_RUN_BLOCKED}`).length;
    } catch (error) {
      tick.errors += 1;
      log({ level: 'error', owner, message: error.message });
    }
    if (tick.errors > 0) failed = true;
    log(tick);
  }
  return failed ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { main };
