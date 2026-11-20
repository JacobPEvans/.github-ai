const { execFileSync, spawnSync } = require('node:child_process');
const {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join, resolve } = require('node:path');
const { describe, expect, it } = require('bun:test');

const helperPath = resolve(__dirname, '../.github/scripts/shared/verified-commit.js');
const runner = `
  const { stageChanges } = require(${JSON.stringify(helperPath)});
  try {
    process.stdout.write(JSON.stringify(stageChanges()));
  } catch (error) {
    process.stderr.write(error.message);
    process.exit(1);
  }
`;

function withRepo(run) {
  const repo = mkdtempSync(join(tmpdir(), 'aiwf-verified-commit-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  try {
    run(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function stageChanges(repo) {
  return spawnSync(process.execPath, ['-e', runner], { cwd: repo, encoding: 'utf8' });
}

describe('verified commit staging', () => {
  it('preserves regular file bytes from the staged Git blob', () => {
    withRepo((repo) => {
      const bytes = Buffer.from([0, 255, 1, 128]);
      writeFileSync(join(repo, 'binary.bin'), bytes);

      const result = stageChanges(repo);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        additions: [{ path: 'binary.bin', contents: bytes.toString('base64') }],
        deletions: [],
      });
    });
  });

  it('rejects symlinks without reading their targets', () => {
    withRepo((repo) => {
      const secret = 'publisher-only-fixture-content';
      const target = join(tmpdir(), `${basename(repo)}-outside`);
      writeFileSync(target, secret);
      symlinkSync(target, join(repo, 'agent-link'));

      try {
        const result = stageChanges(repo);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Cannot publish non-regular staged file "agent-link"');
        expect(result.stderr).not.toContain(secret);
      } finally {
        rmSync(target, { force: true });
      }
    });
  });
});

describe('openPr auto-merge', () => {
  const { openPr } = require('../.github/scripts/shared/verified-commit.js');
  const { createMockCore, createMockContext } = require('./helpers.js');
  const { mock } = require('bun:test');

  async function open(options) {
    const { execFileSync } = require('node:child_process');
    const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
    const { join } = require('node:path');
    const { tmpdir } = require('node:os');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const dir = mkdtempSync(join(tmpdir(), 'openpr-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, env });
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'one\n'); git('add', '-A'); git('commit', '-qm', 'init');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    const github = {
      graphql: mock(async () => ({ createCommitOnBranch: { commit: { oid: 'oid' } } })),
      rest: {
        git: { createRef: mock(async () => ({})) },
        pulls: { create: mock(async () => ({ data: { number: 5, node_id: 'n', html_url: 'u' } })) },
        issues: { addLabels: mock(async () => ({})) },
      },
    };
    const core = createMockCore();
    const prev = process.cwd();
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.chdir(dir);
    try {
      await openPr({ github, context: createMockContext(), core, branch: 'b', title: 't', body: 'x', baseBranch: 'main', ...options });
    } finally {
      process.chdir(prev);
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
      rmSync(dir, { recursive: true, force: true });
    }
    const armed = github.graphql.mock.calls.some((c) => c[0].includes('enablePullRequestAutoMerge'));
    return { armed, output: core.getOutput('auto_merge') };
  }

  it('arms auto-merge by default', async () => {
    expect(await open({})).toEqual({ armed: true, output: 'true' });
  });

  it('leaves auto-merge off with autoMerge: false', async () => {
    expect(await open({ autoMerge: false, labels: ['enhancement'] })).toEqual({ armed: false, output: 'false' });
  });
});
