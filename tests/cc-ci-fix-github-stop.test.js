const { expect, test } = require('bun:test');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const workflow = Bun.YAML.parse(readFileSync('.github/workflows/cc-ci-fix.yml', 'utf8'));
const stop = Object.values(workflow.jobs)
  .flatMap((job) => job.steps || [])
  .find((step) => step.id === 'workflow-files');
const script = join(process.cwd(), '.github/scripts/ci-fix/stop-github-patch.sh');

const edited = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
const created = (path) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+b\n`;

// Runs the stop script on a patch; files are written into the checkout first. Returns its GITHUB_OUTPUT lines.
function stopped(patch, files = {}, gitInit = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-ci-fix-github-stop-'));
  const output = join(directory, 'github-output');
  try {
    if (gitInit) Bun.spawnSync(['git', 'init', '-q'], { cwd: directory });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
    writeFileSync(join(directory, 'agent.patch'), patch);
    writeFileSync(output, '');
    const result = Bun.spawnSync(['bash', script], {
      cwd: directory,
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(directory, 'summary'), GITHUB_RUN_ID: '1' },
    });
    expect(result.exitCode).toBe(0);
    return readFileSync(output, 'utf8').trim().split('\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the workflow-files step calls the stop script from the shared checkout', () => {
  expect(stop).toBeDefined();
  expect(stop.run.trim()).toBe('bash .ai-workflows/.github/scripts/ci-fix/stop-github-patch.sh');
});

test('a patch under .github/actions or .github/workflows is held without failing the step', () => {
  for (const path of ['.github/actions/x/action.yml', '.github/workflows/ci.yml']) {
    expect(stopped(edited(path))).toEqual(['touched=true', 'reason=The patch edits files under `.github/`']);
  }
});

test('a patch outside .github is not stopped', () => {
  expect(stopped(edited('roles/x/tasks/main.yml'))).toEqual(['touched=false']);
});

test('a patch that touches more than 25 files is held; 25 files pass', () => {
  const patch = (n) => Array.from({ length: n }, (_, i) => edited(`roles/x/tasks/f${i}.yml`)).join('');
  expect(stopped(patch(25))).toEqual(['touched=false']);
  expect(stopped(patch(26))).toEqual(['touched=true', 'reason=The patch touches 26 files, more than 25']);
});

test('removing files from a dependency install path does not count toward the 25; other removals do', () => {
  const removedFile = (path) =>
    `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n`;
  const many = (prefix) => Array.from({ length: 40 }, (_, i) => removedFile(`${prefix}/f${i}.yml`)).join('');
  const requirements = { 'requirements.yml': 'roles:\n  - name: acme.widget\n' };
  expect(stopped(many('roles/acme.widget/tasks') + edited('roles/x/tasks/main.yml'), requirements)).toEqual(['touched=false']);
  expect(stopped(many('collections/ns/x'))).toEqual(['touched=false']);
  expect(stopped(many('roles/x/tasks'), requirements)).toEqual(['touched=true', 'reason=The patch touches 40 files, more than 25']);
});

test('a patch that adds files under node_modules/, .venv/ or collections/ is held', () => {
  for (const path of ['node_modules/x/index.js', 'web/node_modules/x/index.js', '.venv/bin/x', 'collections/ns/x/galaxy.yml']) {
    expect(stopped(created(path))[1]).toBe(
      'reason=The patch adds files under a dependency install path (node_modules/, .venv/ or collections/)');
  }
});

test('a patch that adds files under a role named in requirements.yml is held; a local role is not', () => {
  const files = { 'requirements.yml': 'roles:\n  - name: xanmanning.k3s\n    version: v3.4.4\ncollections:\n  - name: community.general\n' };
  expect(stopped(created('roles/xanmanning.k3s/docs/a.md'), files)).toEqual([
    'touched=true', 'reason=The patch adds files under `roles/xanmanning.k3s/`, a role installed from requirements.yml']);
  expect(stopped(created('roles/postgres/tasks/exporter.yml'), files)).toEqual(['touched=false']);
});

test('a patch that adds a file the ignore rules exclude is held; an edit to a tracked file is not', () => {
  const files = { '.gitignore': 'build/\n' };
  expect(stopped(created('build/out.txt'), files, true)).toEqual([
    'touched=true', "reason=The patch adds a file the repository's ignore rules exclude"]);
  expect(stopped(edited('build/out.txt'), files, true)).toEqual(['touched=false']);
});
