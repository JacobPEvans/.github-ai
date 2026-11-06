const { expect, test } = require('bun:test');
const { mkdtempSync, readFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const load = (file) => Bun.YAML.parse(readFileSync(file, 'utf8'));
const action = load('.github/actions/select-router-model/action.yml');
const drift = load('.github/workflows/docs-drift.yml');
const responder = load('.github/workflows/cc-pr-review-responder.yml');
const selector = (job) => job.steps.find((step) => step.id === 'router-model');

test('shared model selection prefers the local role and preserves the default', () => {
  const step = action.runs.steps[0];
  expect(step.env.MODEL).toBe('${{ inputs.local_model || inputs.model }}');
  expect(action.outputs.model.value).toBe('${{ steps.select.outputs.model }}');
  const dir = mkdtempSync(join(tmpdir(), 'router-model-'));
  try {
    for (const [model, local] of [['medium', ''], ['medium', 'review-local'], ['', '']]) {
      const output = join(dir, `output-${local || model || 'empty'}`);
      const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', step.run], {
        env: { ...process.env, MODEL: local || model, GITHUB_OUTPUT: output },
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe(`model=${local || model}\n`);
    }
    for (const model of ['review-local\nother=value', 'review-local\rother=value']) {
      const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', step.run], {
        env: { ...process.env, MODEL: model, GITHUB_OUTPUT: join(dir, 'invalid') },
      });
      expect(result.exitCode).not.toBe(0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('both workflows load the shared selector from the pinned tooling checkout', () => {
  for (const job of [drift.jobs.drift, responder.jobs.respond]) {
    expect(selector(job).uses).toBe('./.ai-workflows/.github/actions/select-router-model');
    const checkout = job.steps.find((step) => step.with?.repository === 'JacobPEvans/.github-ai');
    expect(checkout.with['sparse-checkout']).toContain('.github/actions/select-router-model');
    expect(checkout.with.ref).toBe('${{ job.workflow_sha }}');
  }
  expect(selector(responder.jobs.respond).with.local_model).toBe("${{ inputs.local_only && inputs.local_model || '' }}");
  const agent = responder.jobs.respond.steps.find((step) => step.id === 'agent');
  expect(agent.with.claude_model).toBe('${{ steps.router-model.outputs.model }}');
});

test('docs drift preserves defaults and uses the selected model for inference and reporting', () => {
  expect(drift.on.workflow_call.inputs.model.default).toBe('medium');
  expect(drift.on.workflow_call.inputs.local_model.default).toBe('');
  expect(selector(drift.jobs.drift).with).toEqual({
    model: '${{ inputs.model }}', local_model: '${{ inputs.local_model }}',
  });
  const steps = drift.jobs.drift.steps;
  const inference = steps.find((step) => step.id === 'drift');
  expect(steps.indexOf(selector(drift.jobs.drift))).toBeLessThan(steps.indexOf(inference));
  expect(inference.with.model).toBe('${{ steps.router-model.outputs.model }}');
  expect(inference.with.token).toBe('${{ secrets.LLM_ROUTER_API_KEY }}');
  expect(steps.find((step) => step.name === 'Render report').env.MODEL).toBe('${{ steps.router-model.outputs.model }}');
});

test('dogfood selects the local router role', () => {
  const dogfood = load('.github/workflows/dogfood-docs-drift.yml');
  expect(dogfood.jobs['docs-drift'].with.local_model).toBe('review-local');
});
