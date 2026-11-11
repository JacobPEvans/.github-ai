const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../scripts/pr-reconcile-cli.js');

const ENV_KEYS = ['PR_RECONCILE_OWNERS', 'PR_RECONCILE_TOKEN_DIR', 'PR_RECONCILE_DRY_RUN', 'PR_NUMBER', 'BASE_REF', 'SWEEP_OWNER', 'RESOLVER_REPO'];
const REPO = 'test-owner/test-repo';

function pr(overrides = {}) {
  return {
    number: 7,
    state: 'open',
    mergeable_state: 'clean',
    head: { ref: 'feat/x', sha: 'head1', repo: { full_name: REPO } },
    base: { ref: 'develop', sha: 'base1', repo: { full_name: REPO } },
    user: { login: 'someone' },
    labels: [],
    body: '',
    ...overrides,
  };
}

// Fake HTTP layer under a real Octokit client: every request is recorded, and the handler
// answers by method and path. A token other than the one the handler expects gets a 401.
function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const { pathname } = new URL(url);
    const auth = new Headers(init.headers).get('authorization') || '';
    calls.push({ method, pathname, auth });
    const { status = 200, body = {} } = handler(method, pathname, auth) || {};
    const response = new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4990', 'x-ratelimit-limit': '5000' },
    });
    // Octokit reads response.url, which a constructed Response leaves empty.
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  return { fetch, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

function sweepHandler(prData) {
  return (method, pathname, auth) => {
    if (!auth.endsWith('good-token')) return { status: 401, body: { message: 'Bad credentials' } };
    if (method === 'GET' && pathname === '/search/issues') {
      return { body: { total_count: 1, incomplete_results: false, items: [{ number: 7, repository_url: `https://api.github.com/repos/${REPO}` }] } };
    }
    if (method === 'GET' && pathname === '/repos/test-owner/test-repo/pulls/7') return { body: prData };
    if (method === 'GET' && pathname.endsWith('/status')) return { body: { statuses: [] } };
    if (method === 'POST' && pathname.includes('/statuses/')) return { status: 201, body: {} };
    return { status: 404, body: { message: 'Not Found' } };
  };
}

describe('pr-reconcile-cli', () => {
  let dir;
  let saved;
  let lines;
  const out = (line) => lines.push(line);
  const parsed = () => lines.map((line) => JSON.parse(line));

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-reconcile-cli-'));
    fs.writeFileSync(path.join(dir, 'test-owner'), 'good-token\n');
    process.env.PR_RECONCILE_OWNERS = 'test-owner';
    process.env.PR_RECONCILE_TOKEN_DIR = dir;
    lines = [];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sweeps an owner, prints one tick line for it, and exits 0 when clean', async () => {
    const fake = fakeFetch(sweepHandler(pr()));
    const code = await main({ fetch: fake.fetch, out });
    expect(code).toBe(0);
    const tick = parsed().find((line) => line.event === 'tick');
    expect(tick).toMatchObject({ owner: 'test-owner', prs: 1, errors: 0, ratelimit_remaining: '4990', ratelimit_limit: '5000' });
    expect(tick.requests).toBeGreaterThan(0);
    expect(parsed().filter((line) => line.event === 'tick')).toHaveLength(1);
  });
});
