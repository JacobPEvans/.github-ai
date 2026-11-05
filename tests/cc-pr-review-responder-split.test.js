const { expect, test } = require('bun:test');
const { readFileSync } = require('fs');
const { join } = require('path');

// cc-pr-review-responder's agent job reads review text, which is untrusted. Only the jobs
// that write (publish, and the gateway report) may hold the App key or the App id.
const file = join('.github', 'workflows', 'cc-pr-review-responder.yml');
const workflow = Bun.YAML.parse(readFileSync(file, 'utf8'));
const APP_REFS = ['GH_APP_CLAUDE_BOT_PRIVATE_KEY', 'GH_APP_CLAUDE_BOT_ID'];

const mentionsApp = (node) => {
  const text = JSON.stringify(node);
  return APP_REFS.some((ref) => text.includes(ref));
};

const stepIndex = (job, name) => job.steps.findIndex((step) => step.name === name);

test('the agent job holds neither the App key nor the App id', () => {
  expect(mentionsApp(workflow.jobs.respond)).toBe(false);
});

test('the agent job requests only read scopes', () => {
  for (const [scope, level] of Object.entries(workflow.jobs.respond.permissions)) {
    expect(level, scope).toBe('read');
  }
});

test('only the write jobs reference the App key or the App id', () => {
  const holders = Object.entries(workflow.jobs)
    .filter(([, job]) => mentionsApp(job))
    .map(([name]) => name)
    .sort();
  expect(holders).toEqual(['publish', 'report-gateway']);
});

test('the agent job exposes the gateway class to the gateway report job', () => {
  expect(workflow.jobs.respond.outputs.gateway_class).toBe('${{ steps.agent.outputs.gateway_class }}');
  expect(workflow.jobs['report-gateway'].needs).toContain('respond');
  expect(workflow.jobs['report-gateway'].if).toContain('needs.respond.outputs.gateway_class');
});

test('the publish job validates the patch before applying it', () => {
  const validate = stepIndex(workflow.jobs.publish, 'Validate agent patch');
  const apply = stepIndex(workflow.jobs.publish, 'Apply agent patch');
  expect(validate).toBeGreaterThanOrEqual(0);
  expect(validate).toBeLessThan(apply);
  expect(workflow.jobs.publish.steps[validate].run).toContain('.ai-workflows');
});

test('the patch check matches the tooling path case-insensitively', () => {
  // On a case-insensitive filesystem, .AI-WORKFLOWS names the same checkout.
  const run = workflow.jobs.publish.steps[stepIndex(workflow.jobs.publish, 'Validate agent patch')].run;
  expect(run).toMatch(/grep -q[a-zA-Z]*i[a-zA-Z]* /);
});
