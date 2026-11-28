const { expect, test } = require('bun:test');
const { readFileSync } = require('fs');

const workflow = Bun.YAML.parse(readFileSync('.github/workflows/cc-code-simplifier.yml', 'utf8'));
const call = (workflow.on ?? workflow[true]).workflow_call;
const run = workflow.jobs.simplify.steps.find((step) => step.name === 'Run AI agent');

test('cc-code-simplifier keeps the configured agent unless the caller picks one', () => {
  expect(call.inputs.agent.default).toBe('');
  expect(run.with.agent).toBe("${{ inputs.agent || vars.GH_ACTION_AI_AGENT || 'claude' }}");
});

test('cc-code-simplifier runs OpenHands on the caller-named router role', () => {
  expect(call.inputs.local_model.default).toBe('medium');
  expect(run.with.openhands_model).toBe('${{ inputs.local_model }}');
  expect(run.with.api_key).toBe('${{ secrets.LLM_ROUTER_API_KEY }}');
});
