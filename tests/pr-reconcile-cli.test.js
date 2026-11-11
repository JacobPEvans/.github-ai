const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../scripts/pr-reconcile-cli.js');

const ENV_KEYS = [
  'PR_RECONCILE_OWNERS', 'PR_RECONCILE_TOKEN_DIR', 'PR_RECONCILE_DRY_RUN', 'PR_RECONCILE_FENCE',
  'PR_NUMBER', 'BASE_REF', 'SWEEP_OWNER', 'RESOLVER_REPO',
];
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

function sweepHandler(prData, statuses = [], searchRepo = 'test-repo') {
  return (method, pathname, auth) => {
    if (!auth.endsWith('good-token')) return { status: 401, body: { message: 'Bad credentials' } };
    if (method === 'GET' && pathname === '/search/issues') {
      return { body: { total_count: 1, incomplete_results: false, items: [{ number: 7, repository_url: `https://api.github.com/repos/test-owner/${searchRepo}` }] } };
    }
    if (method === 'GET' && pathname === '/repos/test-owner/test-repo/pulls/7') return { body: prData };
    if (method === 'GET' && pathname.endsWith('/status')) return { body: { statuses } };
    if (method === 'GET' && pathname.includes('/branches/')) return { body: { commit: { sha: 'base1' } } };
    if (method === 'PUT' && pathname.endsWith('/update-branch')) return { status: 202, body: {} };
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
    process.env.PR_RECONCILE_FENCE = 'fence-owner,fence-prefix-*,fence-repo';
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

  it('refuses to start without an owner list or token directory, and sends no request', async () => {
    delete process.env.PR_RECONCILE_TOKEN_DIR;
    const fake = fakeFetch(sweepHandler(pr()));
    expect(await main({ fetch: fake.fetch, out })).toBe(1);
    expect(fake.calls).toHaveLength(0);
    expect(parsed()).toHaveLength(1);
  });

  it('ends an owner with a missing token file in one error line with no write, and still runs the next owner', async () => {
    process.env.PR_RECONCILE_OWNERS = 'missing-owner,test-owner';
    const fake = fakeFetch(sweepHandler(pr()));
    expect(await main({ fetch: fake.fetch, out })).toBe(1);
    const errors = parsed().filter((line) => line.level === 'error');
    expect(errors).toEqual([expect.objectContaining({ owner: 'missing-owner', message: 'token file is missing or unreadable' })]);
    expect(fake.calls.every((c) => c.auth === 'token good-token')).toBe(true);
    expect(fake.writes().every((c) => c.pathname.includes('/statuses/'))).toBe(true);
    expect(parsed().find((line) => line.event === 'tick' && line.owner === 'test-owner').prs).toBe(1);
  });

  it('ends an owner that gets a 401 on its first request in one error line with no write, and still runs the next owner', async () => {
    fs.writeFileSync(path.join(dir, 'bad-owner'), 'bad-token\n');
    process.env.PR_RECONCILE_OWNERS = 'bad-owner,test-owner';
    const fake = fakeFetch(sweepHandler(pr()));
    expect(await main({ fetch: fake.fetch, out })).toBe(1);
    const errors = parsed().filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ owner: 'bad-owner' });
    expect(fake.calls.filter((c) => c.auth === 'token bad-token').map((c) => c.method)).toEqual(['GET']);
    expect(fake.writes().every((c) => c.auth === 'token good-token')).toBe(true);
    expect(parsed().find((line) => line.event === 'tick' && line.owner === 'test-owner').prs).toBe(1);
  });

  it('refuses to start when the fence list is unset, and sends no request', async () => {
    delete process.env.PR_RECONCILE_FENCE;
    const fake = fakeFetch(sweepHandler(pr()));
    expect(await main({ fetch: fake.fetch, out })).toBe(1);
    expect(fake.calls).toHaveLength(0);
    expect(parsed()).toHaveLength(1);
  });

  it('fails a fenced owner before its token is read or any request is sent, and still runs the next owner', async () => {
    process.env.PR_RECONCILE_OWNERS = 'fence-prefix-a,test-owner';
    const fake = fakeFetch(sweepHandler(pr()));
    expect(await main({ fetch: fake.fetch, out })).toBe(1);
    const errors = parsed().filter((line) => line.level === 'error');
    expect(errors).toEqual([expect.objectContaining({ owner: 'fence-prefix-a', message: 'owner is fenced' })]);
    expect(fake.calls.some((c) => c.auth !== 'token good-token')).toBe(false);
    expect(parsed().find((line) => line.event === 'tick' && line.owner === 'test-owner').prs).toBe(1);
  });

  it('fails an owner whose search returns a fenced repository with zero writes', async () => {
    const fake = fakeFetch(sweepHandler(pr(), [], 'fence-repo'));
    expect(await main({ fetch: fake.fetch, out })).toBe(1);
    expect(parsed().filter((line) => line.level === 'error')).toEqual([expect.objectContaining({ owner: 'test-owner', message: 'sweep refused: search returned a fenced repository' })]);
    expect(fake.writes()).toHaveLength(0);
    expect(fake.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('blocks every write in a dry run, logs each blocked call, and never sends updateBranch', async () => {
    process.env.PR_RECONCILE_DRY_RUN = '1';
    const fake = fakeFetch(sweepHandler(pr({ mergeable_state: 'behind' }), [{ context: 'merge-hold', state: 'success' }]));
    expect(await main({ fetch: fake.fetch, out })).toBe(0);
    expect(fake.writes()).toHaveLength(0);
    expect(fake.calls.some((c) => c.pathname.endsWith('/update-branch'))).toBe(false);
    const blocked = parsed().filter((line) => line.event === 'dry_run_blocked');
    expect(blocked).toEqual([expect.objectContaining({ owner: 'test-owner', method: 'PUT' })]);
    expect(blocked[0].route).toBe('/repos/{owner}/{repo}/pulls/{pull_number}/update-branch');
    expect(parsed().find((line) => line.event === 'tick')).toMatchObject({ prs: 1, errors: 0 });
  });
});
