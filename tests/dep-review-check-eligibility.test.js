const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const { createMockCore, createMockContext, createMockGithub } = require('./helpers.js');
const run = require('../.github/scripts/dep-review/check-eligibility.js');
const { parseUpdateTypes, highestSemverType } = run;

const ENV_KEYS = ['UPDATE_TYPES', 'REQUIRE_LABEL', 'BOT_AUTHORS'];

function renovateBody(updateType) {
  return [
    'This PR contains the following updates:',
    '',
    '| Package | Type | Update | Change |',
    '|---|---|---|---|',
    `| [some-dep](https://example.test) | action | ${updateType} | \`v1.0.0\` → \`v2.0.0\` |`,
    '',
    '### Release Notes',
    'The word major appears in prose but only table rows count.',
  ].join('\n');
}

function makePayload({ login = 'renovate[bot]', body = renovateBody('major'), labels = [], number = 9 } = {}) {
  return { pull_request: { number, body, labels, user: { login, type: 'Bot' } } };
}

describe('dep-review/parseUpdateTypes', () => {
  it('reads types from table rows only', () => {
    expect(parseUpdateTypes(renovateBody('minor'))).toEqual(['minor']);
  });

  it('collects multiple types from grouped PRs and ranks major highest', () => {
    const grouped = renovateBody('patch') + '\n| [other-dep](x) | action | major | `v1` → `v2` |';
    const types = parseUpdateTypes(grouped);
    expect(types).toContain('patch');
    expect(types).toContain('major');
    expect(highestSemverType(types)).toBe('major');
  });

  it('returns no semver type for digest/lockfile rows', () => {
    expect(highestSemverType(parseUpdateTypes(renovateBody('digest')))).toBe(null);
    expect(highestSemverType(parseUpdateTypes(renovateBody('lockFileMaintenance')))).toBe(null);
  });
});

describe('dep-review/check-eligibility', () => {
  let core, context, github;

  beforeEach(() => {
    core = createMockCore();
    context = createMockContext({ payload: makePayload() });
    github = createMockGithub();
    github.paginate.mockResolvedValue([]);
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('happy path: renovate major bump passes all gates', async () => {
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('true');
    expect(core.getOutput('pr_number')).toBe('9');
    expect(core.getOutput('update_type')).toBe('major');
  });

  it('skip: human-authored PR', async () => {
    context.payload = makePayload({ login: 'some-user' });
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('false');
  });

  it('skip: patch bump under default update_types', async () => {
    context.payload = makePayload({ body: renovateBody('patch') });
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('false');
  });

  it('skip: digest-only PR has no semver type', async () => {
    context.payload = makePayload({ body: renovateBody('digest') });
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('false');
  });

  it('reviews non-semver update types only when callers opt in', async () => {
    const updateTypes = ['digest', 'pin', 'pinDigest', 'lockFileMaintenance'];
    process.env.UPDATE_TYPES = updateTypes.join(',');

    for (const updateType of updateTypes) {
      core = createMockCore();
      context.payload = makePayload({ body: renovateBody(updateType) });
      await run({ github, context, core });
      expect(core.getOutput('should_run')).toBe('true');
      expect(core.getOutput('update_type')).toBe(updateType);
    }
  });

  it('honors a custom update_types list', async () => {
    process.env.UPDATE_TYPES = 'major,minor,patch';
    context.payload = makePayload({ body: renovateBody('patch') });
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('true');
    expect(core.getOutput('update_type')).toBe('patch');
  });

  it('skip: required label missing; run when present', async () => {
    process.env.REQUIRE_LABEL = 'dependencies';
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('false');

    core = createMockCore();
    context.payload = makePayload({ labels: [{ name: 'dependencies' }] });
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('true');
  });

  it('skips the reviewed head, but reviews a new head', async () => {
    context.payload.pull_request.head = { sha: 'abc' };
    github.paginate.mockResolvedValue([{ body: '<!-- cc-dep-review -->\n<!-- cc-dep-review-head:abc -->' }]);
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('false');
    context.payload.pull_request.head.sha = 'def';
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('true');
  });

  it('reviews Dependabot single and grouped version updates', async () => {
    for (const text of ['Bump thing from 1.0.0 to 2.0.0', 'Bumps [one](url) from 1.2 to 1.3\nBumps [two](url) from 1 to 2']) {
      context.payload = makePayload({ login: 'dependabot[bot]', body: text });
      await run({ github, context, core });
      expect(core.getOutput('should_run')).toBe('true');
      expect(core.getOutput('update_type')).toBe('major');
    }
  });

  it('honors explicit bot restrictions for Dependabot', async () => {
    process.env.BOT_AUTHORS = 'renovate[bot]';
    context.payload = makePayload({ login: 'dependabot[bot]', body: 'Bump thing from 1 to 2' });
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('false');
  });

  it('skip: no pull_request payload', async () => {
    context.payload = {};
    await run({ github, context, core });
    expect(core.getOutput('should_run')).toBe('false');
  });
});
