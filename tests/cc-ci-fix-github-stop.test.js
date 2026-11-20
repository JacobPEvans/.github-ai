const { expect, test } = require('bun:test');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const workflow = Bun.YAML.parse(readFileSync('.github/workflows/cc-ci-fix.yml', 'utf8'));
const stop = Object.values(workflow.jobs)
  .flatMap((job) => job.steps || [])
  .find((step) => step.id === 'workflow-files');
const script = join(process.cwd(), '.github/scripts/ci-fix/stop-github-patch.sh');

function touched(path, exitCode) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-ci-fix-github-stop-'));
  const output = join(directory, 'github-output');
  try {
    writeFileSync(join(directory, 'agent.patch'), `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`);
    writeFileSync(output, '');
    const result = Bun.spawnSync(['bash', script], {
      cwd: directory,
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(directory, 'summary'), GITHUB_RUN_ID: '1' },
    });
    expect(result.exitCode).toBe(exitCode);
    return readFileSync(output, 'utf8').trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the workflow-files step calls the stop script from the shared checkout', () => {
  expect(stop).toBeDefined();
  expect(stop.run.trim()).toBe('bash .ai-workflows/.github/scripts/ci-fix/stop-github-patch.sh');
});

test('a patch under .github/actions is stopped and fails the step', () => {
  expect(touched('.github/actions/x/action.yml', 1)).toBe('touched=true');
});

test('a patch under .github/workflows is stopped and fails the step', () => {
  expect(touched('.github/workflows/ci.yml', 1)).toBe('touched=true');
});

test('a patch outside .github is not stopped', () => {
  expect(touched('roles/x/tasks/main.yml', 0)).toBe('touched=false');
});
