const { expect, test } = require('bun:test');
const { readFileSync } = require('fs');
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
