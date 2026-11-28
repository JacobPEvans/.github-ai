const { expect, test } = require('bun:test');
const { readFileSync } = require('fs');

const source = readFileSync('.github/workflows/openhands-review.yml', 'utf8');
const workflow = Bun.YAML.parse(source);
const call = (workflow.on ?? workflow[true]).workflow_call;
const { review, verdict } = workflow.jobs;
const run = review.steps.find((step) => step.name === 'Run the OpenHands review');

test('openhands-review defaults to the local capability on the agent pool', () => {
  expect(call.inputs.model.default).toBe('medium');
  expect(call.inputs.runner_label.default).toBe('review');
  expect(review['runs-on']).toBe("${{ inputs.runner_label || 'review' }}");
  expect(call.inputs.block.default).toBe(true);
  expect(Object.keys(call.secrets)).toEqual(['LLM_ROUTER_BASE_URL', 'LLM_ROUTER_API_KEY']);
});

test('openhands-review sends every model request to the router with the private key', () => {
  expect(run.env.LLM_MODEL).toBe('openai/${{ inputs.model }}');
  expect(run.env.LLM_BASE_URL).toBe('${{ secrets.LLM_ROUTER_BASE_URL }}');
  expect(run.env.LLM_API_KEY).toBe('${{ secrets.LLM_ROUTER_API_KEY }}');
  expect(source).not.toContain('OSS');
});

test('openhands-review never gives a fork head the router key', () => {
  expect(workflow.permissions).toEqual({});
  expect(review.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  for (const step of review.steps.filter((s) => s.uses?.startsWith('actions/checkout@'))) {
    expect(step.with['persist-credentials']).toBe(false);
  }
});

test('openhands-review pins every non-local action to a commit', () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps.filter((s) => s.uses && !s.uses.startsWith('./'))) {
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  }
});

test('the verdict job decides from the review on the head commit', () => {
  expect(verdict.needs).toBe('review');
  expect(verdict.permissions).toEqual({ 'pull-requests': 'read' });
  const script = verdict.steps[0].run;
  expect(script).toContain('env.HEAD_SHA');
  expect(script).toContain('CHANGES_REQUESTED');
  expect(script).toContain('NONE');
});
