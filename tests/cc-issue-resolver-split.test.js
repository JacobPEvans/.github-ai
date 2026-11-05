const { expect, test } = require('bun:test');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { spawnSync } = require('child_process');
const { tmpdir } = require('os');
const { join } = require('path');

// cc-issue-resolver's agent job reads the issue body, which is untrusted text. Only the
// publish job, which applies the agent's patch, may hold the App key or the App id.
const file = join('.github', 'workflows', 'cc-issue-resolver.yml');
const workflow = Bun.YAML.parse(readFileSync(file, 'utf8'));
const APP_REFS = ['GH_APP_CLAUDE_BOT_PRIVATE_KEY', 'GH_APP_CLAUDE_BOT_ID'];

const mentionsApp = (node) => {
  const text = JSON.stringify(node);
  return APP_REFS.some((ref) => text.includes(ref));
};

const stepIndex = (job, name) => job.steps.findIndex((step) => step.name === name);

test('the agent job holds neither the App key nor the App id', () => {
  expect(mentionsApp(workflow.jobs.resolve)).toBe(false);
});

test('the agent job requests only read scopes', () => {
  for (const [scope, level] of Object.entries(workflow.jobs.resolve.permissions)) {
    expect(level, scope).toBe('read');
  }
});

test('only the publish job references the App key or the App id', () => {
  const holders = Object.entries(workflow.jobs)
    .filter(([, job]) => mentionsApp(job))
    .map(([name]) => name);
  expect(holders).toEqual(['publish']);
});

test('the agent job exposes the gateway class to the publish job', () => {
  expect(workflow.jobs.resolve.outputs.gateway_class).toBe('${{ steps.agent.outputs.gateway_class }}');
  expect(workflow.jobs.publish.needs).toContain('resolve');
});

test('the publish job validates the patch before applying it', () => {
  const { steps } = workflow.jobs.publish;
  const validate = stepIndex(workflow.jobs.publish, 'Validate agent patch');
  const apply = stepIndex(workflow.jobs.publish, 'Apply agent patch');
  expect(validate).toBeGreaterThanOrEqual(0);
  expect(validate).toBeLessThan(apply);
  expect(steps[validate].run).toContain('.ai-workflows');
});

// Runs the validate step's script against a patch in a temp dir and returns its exit status.
const runValidator = (patch) => {
  const { run } = workflow.jobs.publish.steps[stepIndex(workflow.jobs.publish, 'Validate agent patch')];
  const dir = mkdtempSync(join(tmpdir(), 'patch-guard-'));
  try {
    writeFileSync(join(dir, 'agent.patch'), patch);
    return spawnSync('bash', ['-e', '-c', run], { cwd: dir, encoding: 'utf8' }).status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const patchTouching = (path) => `diff --git ${path} ${path}\n--- ${path}\n+++ ${path}\n@@ -0,0 +1 @@\n+x\n`;

test('the patch guard rejects .ai-workflows paths in every spelling git apply accepts', () => {
  for (const path of [
    'a/.ai-workflows/x.sh',
    'a//.ai-workflows/x.sh',
    'a/./.ai-workflows/x.sh',
    'a/./././.ai-workflows/x.sh',
    'a/x/../.ai-workflows/x.sh',
    './.ai-workflows/x.sh',
    '"a/\\056ai-workflows/x.sh"',
  ]) {
    expect(runValidator(patchTouching(path)), path).not.toBe(0);
  }
});

test('the patch guard allows patches outside .ai-workflows', () => {
  expect(runValidator(patchTouching('a/src/main.tf'))).toBe(0);
});
