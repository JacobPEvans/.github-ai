const { describe, it, expect, beforeEach, afterEach, mock } = require('bun:test');
const path = require('path');
const { createMockCore, createMockContext } = require('./helpers.js');

const run = require('../.github/scripts/verdict/hold-class.js');

const HOLD_FILE = path.join(__dirname, '../.github/scripts/verdict/hold-class.json');
const PROTECTED = { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }] };

function makeGithub({ files = [], labels = [], environment = PROTECTED, environmentError } = {}) {
  const getEnvironment = mock(async () => {
    if (environmentError) throw environmentError;
    return { data: environment };
  });
  const github = {
    rest: {
      pulls: { get: mock(async () => ({ data: { labels: labels.map((name) => ({ name })) } })), listFiles: 'listFiles' },
      repos: { getEnvironment },
    },
    paginate: mock(async () => files.map((f) => (typeof f === 'string' ? { filename: f } : f))),
  };
  return { github, getEnvironment };
}

describe('hold-class', () => {
  let core, context;

  beforeEach(() => {
    core = createMockCore();
    context = createMockContext();
    process.env.PR_NUMBER = '7';
    process.env.HOLD_FILE = HOLD_FILE;
  });

  afterEach(() => {
    delete process.env.PR_NUMBER;
    delete process.env.HOLD_FILE;
  });

  it('is not hold class for ordinary source and docs changes', async () => {
    const { github, getEnvironment } = makeGithub({ files: ['src/index.js', 'docs/author-guide.md', 'tests/oauthless.test.js'] });
    await run({ github, context, core });
    expect(core.failures).toHaveLength(0);
    expect(core.getOutput('hold')).toBe('false');
    expect(getEnvironment).not.toHaveBeenCalled();
  });

  for (const file of [
    '.github/workflows/ci.yml',
    'actions/build/action.yml',
    '.github/CODEOWNERS',
    'rulesets/main.tf',
    'roles/openbao/defaults/main.yml',
    'secrets/app.sops.yaml',
    'modules/oidc/main.tf',
    'policies/ci.hcl',
    'policy/deny.rego',
    'firewall/rules.nft',
    'inventory/network.yml',
  ]) {
    it(`is hold class for ${file}`, async () => {
      const { github } = makeGithub({ files: [file] });
      await run({ github, context, core });
      expect(core.failures).toHaveLength(0);
      expect(core.getOutput('hold')).toBe('true');
    });
  }

  it('is hold class when a renamed file came from a hold-class path', async () => {
    const { github } = makeGithub({ files: [{ filename: 'docs/old.md', previous_filename: '.github/workflows/old.yml' }] });
    await run({ github, context, core });
    expect(core.getOutput('hold')).toBe('true');
  });

  it('is hold class with the hold label alone', async () => {
    const { github } = makeGithub({ files: ['README.md'], labels: ['hold'] });
    await run({ github, context, core });
    expect(core.getOutput('hold')).toBe('true');
  });

  it('fails when the hold Environment does not exist', async () => {
    const { github } = makeGithub({ files: ['.github/workflows/ci.yml'], environmentError: Object.assign(new Error('nf'), { status: 404 }) });
    await run({ github, context, core });
    expect(core.failures).toHaveLength(1);
    expect(core.failures[0]).toContain('no hold Environment with required reviewers');
    expect(core.getOutput('hold')).toBeUndefined();
  });

  it('fails when the hold Environment has no required reviewers', async () => {
    const { github } = makeGithub({ files: ['.github/workflows/ci.yml'], environment: { protection_rules: [] } });
    await run({ github, context, core });
    expect(core.failures).toHaveLength(1);
    expect(core.getOutput('hold')).toBeUndefined();
  });

  it('rethrows an Environment API error other than not found', async () => {
    const { github } = makeGithub({ files: ['.github/workflows/ci.yml'], environmentError: Object.assign(new Error('boom'), { status: 500 }) });
    await expect(run({ github, context, core })).rejects.toThrow('boom');
  });
});
