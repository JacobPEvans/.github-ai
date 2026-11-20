const { mock, describe, it, expect } = require('bun:test');
const { readFileSync } = require('node:fs');
const { createMockCore, createMockContext, createMockGithub } = require('./helpers.js');
const { refusal, prepare } = require('../.github/scripts/conflict-fix/prepare.js');
const { numstatPaths, subsetRefusal, readPatch } = require('../.github/scripts/conflict-fix/subset.js');
const { v2Body, v2Labels, waitForCi, publish } = require('../.github/scripts/conflict-fix/publish.js');

const repoName = { full_name: 'test-owner/test-repo' };
function pr(overrides = {}) {
  return {
    number: 7, state: 'open', mergeable_state: 'dirty', title: 'feat: thing', body: 'Adds a thing.',
    head: { ref: 'feat/x', sha: 'head1', repo: repoName }, base: { ref: 'develop', repo: repoName },
    labels: [{ name: 'enhancement' }, { name: 'merge-conflict' }, { name: 'needs-lead' }, { name: 'human:review' }],
    ...overrides,
  };
}
const notFound = () => Object.assign(new Error('nf'), { status: 404 });

describe('prepare', () => {
  const refusals = [
    ['a closed pull request', pr({ state: 'closed' }), false, /is closed/],
    ['a fork head', pr({ head: { ref: 'feat/x', sha: 'h', repo: { full_name: 'fork/test-repo' } } }), false, /fork/],
    ['a v2 head ref', pr({ head: { ref: 'feat/x-v2', sha: 'h', repo: repoName } }), false, /already a v2/],
    ['a v2 body', pr({ body: 'Adds a thing.\n\nSupersedes #3' }), false, /already a v2/],
    ['a pull request that is not conflicted', pr({ mergeable_state: 'clean' }), false, /not conflicted/],
    ['an original whose v2 branch exists', pr(), true, /feat\/x-v2 already exists/],
  ];
  for (const [name, data, v2Exists, reason] of refusals) {
    it(`refuses ${name}`, () => {
      expect(refusal(data, v2Exists)).toMatch(reason);
    });
  }

  it('accepts an open conflicted same-repository pull request without a v2', () => {
    expect(refusal(pr(), false)).toBe('');
  });

  it('retries an unknown state, then writes the outputs for a conflicted pull request', async () => {
    const gh = createMockGithub();
    gh.rest.pulls.get.mockResolvedValueOnce({ data: pr({ mergeable_state: 'unknown' }) }).mockResolvedValueOnce({ data: pr() });
    gh.rest.git = { getRef: mock().mockRejectedValue(notFound()) };
    gh.rest.pulls.listFiles = mock();
    gh.paginate.mockResolvedValue([{ filename: 'src/a.js' }, { filename: 'README.md' }]);
    const core = createMockCore();
    const result = await prepare({ github: gh, context: createMockContext(), core, number: 7, delayMs: 0 });
    expect(result.ok).toBe(true);
    expect(gh.rest.git.getRef.mock.calls[0][0].ref).toBe('heads/feat/x-v2');
    expect(core.outputs.get('changed_files')).toBe('src/a.js\nREADME.md');
    expect(core.outputs.get('base_ref')).toBe('develop');
    expect(core.failures).toEqual([]);
  });

  it('fails the run when the v2 branch exists', async () => {
    const gh = createMockGithub();
    gh.rest.pulls.get.mockResolvedValue({ data: pr() });
    gh.rest.git = { getRef: mock().mockResolvedValue({}) };
    const core = createMockCore();
    const result = await prepare({ github: gh, context: createMockContext(), core, number: 7, delayMs: 0 });
    expect(result.ok).toBe(false);
    expect(core.failures[0]).toMatch(/already exists/);
  });
});

describe('subset rule', () => {
  const { execFileSync } = require('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } = require('node:fs');
  const { join, dirname } = require('node:path');
  const { tmpdir } = require('node:os');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

  // A real git patch from a scratch repository: `before` files are committed, `edit` changes the tree, and the patch
  // is collected the way the fix job collects it.
  function realPatch(before, edit, { noRenames = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'conflict-subset-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
      git('init', '-q');
      git('config', 'user.email', 't@example.com');
      git('config', 'user.name', 't');
      const write = (path, text) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
      for (const [path, text] of Object.entries(before)) write(path, text);
      git('add', '-A');
      git('commit', '-qm', 'base');
      edit({ write, move: (from, to) => { mkdirSync(dirname(join(dir, to)), { recursive: true }); renameSync(join(dir, from), join(dir, to)); } });
      git('add', '-N', '-A');
      const patch = join(dir, 'agent.patch');
      writeFileSync(patch, git('diff', '--binary', ...(noRenames ? ['--no-renames'] : ['-M']), 'HEAD'));
      return readPatch(patch);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const long = 'one\ntwo\nthree\nfour\nfive\nsix\n';

  it('reads unquoted paths, including the rename form, from numstat -z output', () => {
    expect(numstatPaths('1\t1\tsrc/my file.js\u00000\t0\t\u0000old.txt\u0000new.txt\u0000')).toEqual(['src/my file.js', 'old.txt', 'new.txt']);
  });

  it('allows a patch inside the original changed files, including a path with a space', () => {
    const patch = realPatch({ 'src/my file.js': 'a\n' }, ({ write }) => write('src/my file.js', 'b\n'));
    expect(patch.paths).toEqual(['src/my file.js']);
    expect(subsetRefusal(patch, ['src/my file.js'])).toBe('');
    expect(subsetRefusal(patch, ['src/my-file.js'])).toMatch(/does not: src\/my file\.js/);
  });

  it('refuses a .github path that git quotes in the diff header', () => {
    const patch = realPatch({ '.github/é.yml': 'a\n' }, ({ write }) => write('.github/é.yml', 'b\n'));
    expect(patch.paths).toEqual(['.github/é.yml']);
    expect(subsetRefusal(patch, ['.github/é.yml'])).toMatch(/edits \.github\/: \.github\/é\.yml/);
  });

  it('checks both names of a rename collected with --no-renames', () => {
    const patch = realPatch({ 'outside.txt': long }, ({ move }) => move('outside.txt', 'src/a.js'));
    expect(patch.paths.sort()).toEqual(['outside.txt', 'src/a.js']);
    expect(subsetRefusal(patch, ['src/a.js'])).toMatch(/does not: outside\.txt/);
  });

  it('refuses a patch that still carries a rename', () => {
    const patch = realPatch({ 'src/a.js': long }, ({ move }) => move('src/a.js', 'src/b.js'), { noRenames: false });
    expect(subsetRefusal(patch, ['src/a.js', 'src/b.js'])).toMatch(/renames or copies/);
  });

  it('refuses a file the original did not change', () => {
    const patch = realPatch({ 'src/a.js': 'a\n', 'src/b.js': 'a\n' }, ({ write }) => { write('src/a.js', 'b\n'); write('src/b.js', 'b\n'); });
    expect(subsetRefusal(patch, ['src/a.js'])).toMatch(/does not: src\/b\.js/);
  });

  it('refuses an empty patch', () => {
    expect(subsetRefusal(readPatch('/nonexistent/agent.patch'), ['src/a.js'])).toMatch(/empty/);
    expect(subsetRefusal(realPatch({ 'src/a.js': 'a\n' }, () => {}), ['src/a.js'])).toMatch(/empty/);
  });
});

describe('publish', () => {
  it('keeps the original body and adds the supersedes line', () => {
    expect(v2Body('Adds a thing.\n', 7)).toBe('Adds a thing.\n\nSupersedes #7');
    expect(v2Body('', 7)).toBe('Supersedes #7');
  });

  it('copies labels except human:review, merge-conflict and needs-lead', () => {
    expect(v2Labels(pr().labels)).toEqual(['enhancement']);
  });

  it('fails and closes nothing when there is nothing to publish', async () => {
    const gh = publishGithub({ ciStarts: true });
    const core = createMockCore();
    const result = await publish({ github: gh, context: createMockContext(), core, number: 7, open: mock().mockResolvedValue({ opened: false }) });
    expect(result).toEqual({ closed: false });
    expect(gh.rest.pulls.update).not.toHaveBeenCalled();
    expect(core.failures[0]).toMatch(/original stays open/);
  });

  it('waits until a check run or workflow run exists at the v2 head', async () => {
    const gh = createMockGithub();
    gh.rest.checks.listForRef.mockResolvedValue({ data: { total_count: 0 } });
    gh.rest.actions.listWorkflowRunsForRepo = mock()
      .mockResolvedValueOnce({ data: { total_count: 0 } })
      .mockResolvedValueOnce({ data: { total_count: 1 } });
    expect(await waitForCi(gh, 'o', 'r', 'sha', { timeoutMs: 1000, intervalMs: 0 })).toBe(true);
    expect(gh.rest.actions.listWorkflowRunsForRepo.mock.calls[0][0]).toMatchObject({ head_sha: 'sha' });
  });

  function publishGithub({ ciStarts }) {
    const gh = createMockGithub();
    gh.rest.pulls.get.mockResolvedValue({ data: pr() });
    gh.rest.pulls.update = mock().mockResolvedValue({});
    gh.rest.issues.createComment.mockResolvedValue({});
    gh.rest.checks.listForRef.mockResolvedValue({ data: { total_count: ciStarts ? 1 : 0 } });
    gh.rest.actions.listWorkflowRunsForRepo = mock().mockResolvedValue({ data: { total_count: 0 } });
    return gh;
  }
  const opener = () => mock().mockResolvedValue({ opened: true, pr: { number: 9, head: { sha: 'v2sha' } } });

  it('opens the v2 with the same title, then closes the original only after the v2 CI started', async () => {
    const gh = publishGithub({ ciStarts: true });
    const core = createMockCore();
    const open = opener();
    const result = await publish({ github: gh, context: createMockContext(), core, number: 7, timeoutMs: 0, intervalMs: 0, open });
    expect(result).toEqual({ closed: true, v2: 9 });
    expect(open.mock.calls[0][0]).toMatchObject({
      branch: 'feat/x-v2', baseBranch: 'develop', title: 'feat: thing', body: 'Adds a thing.\n\nSupersedes #7', labels: ['enhancement'],
      autoMerge: false,
    });
    expect(gh.rest.checks.listForRef.mock.calls[0][0]).toMatchObject({ ref: 'v2sha' });
    expect(gh.rest.issues.createComment.mock.calls[0][0]).toMatchObject({ issue_number: 7, body: 'Superseded by #9.' });
    expect(gh.rest.pulls.update.mock.calls[0][0]).toMatchObject({ pull_number: 7, state: 'closed' });
    const created = open.mock.invocationCallOrder[0];
    expect(gh.rest.checks.listForRef.mock.invocationCallOrder[0]).toBeGreaterThan(created);
    expect(gh.rest.pulls.update.mock.invocationCallOrder[0]).toBeGreaterThan(gh.rest.checks.listForRef.mock.invocationCallOrder[0]);
  });

  it('leaves the original open and fails when the v2 CI never starts', async () => {
    const gh = publishGithub({ ciStarts: false });
    const core = createMockCore();
    const result = await publish({ github: gh, context: createMockContext(), core, number: 7, timeoutMs: 0, intervalMs: 0, open: opener() });
    expect(result).toEqual({ closed: false, v2: 9 });
    expect(gh.rest.pulls.update).not.toHaveBeenCalled();
    expect(gh.rest.issues.createComment).not.toHaveBeenCalled();
    expect(core.failures[0]).toMatch(/CI never started on #9; #7 stays open/);
  });
});

describe('workflow', () => {
  const workflow = Bun.YAML.parse(readFileSync('.github/workflows/cc-conflict-fix.yml', 'utf8'));
  const { publish: job } = workflow.jobs;
  const names = job.steps.map((step) => step.name);

  it('refuses an uncovered patch before applying it, and reads the token after', () => {
    const order = ['Refuse a patch the original does not cover', 'Apply agent patch',
      'Read the commit token from OpenBao', 'Open the v2 and close the original'].map((name) => names.indexOf(name));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('reads the openhands-write commit token through OIDC and never an App key', () => {
    const token = job.steps.find((step) => step.id === 'commit-token');
    expect(job.permissions['id-token']).toBe('write');
    expect(token.with.secrets).toContain('github/token/');
    expect(job.steps.find((step) => step.id === 'commit-role').run).toContain('openhands-write-');
    expect(JSON.stringify(workflow)).not.toContain('PRIVATE_KEY');
  });

  it('runs one conflict fix per pull request at a time and never cancels it', () => {
    expect(workflow.concurrency).toEqual({ group: 'conflict-fix-${{ github.repository }}-${{ inputs.conflict_pr }}', 'cancel-in-progress': false });
  });

  it('starts the v2 from the base tip the agent worked on', () => {
    const checkout = job.steps.find((step) => step.name === 'Checkout the base tip the agent worked on');
    expect(checkout.with.ref).toBe('${{ needs.fix.outputs.base_sha }}');
  });

  it('collects the agent patch without rename detection', () => {
    const collect = workflow.jobs.fix.steps.find((step) => step.name === 'Collect agent patch');
    expect(collect.run).toContain('git diff --binary --no-renames HEAD > agent.patch');
  });
});
