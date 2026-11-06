const { expect, test } = require('bun:test');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const action = Bun.YAML.parse(readFileSync('.github/actions/local-model-setup/action.yml', 'utf8'));
const validate = action.runs.steps[0];
const valid = {
  LOCAL_MODEL: 'local-role', LLM_ROUTER_BASE_URL: 'https://example.invalid/v1',
  OPENBAO_ADDR: 'https://example.invalid', OTEL_ENDPOINT: 'https://example.invalid/traces',
  DAILY_RUN_LIMIT: '5',
};

test('local-only validation accepts complete settings', () => {
  expect(spawnSync('bash', ['-e', '-c', validate.run], { env: valid }).status).toBe(0);
});

for (const key of Object.keys(valid)) {
  test(`local-only validation rejects empty ${key}`, () => {
    expect(spawnSync('bash', ['-e', '-c', validate.run], { env: { ...valid, [key]: '' } }).status).toBe(1);
  });
}

for (const limit of ['0', '-1', 'abc']) {
  test(`local-only validation rejects limit ${limit}`, () => {
    expect(spawnSync('bash', ['-e', '-c', validate.run], {
      env: { ...valid, DAILY_RUN_LIMIT: limit },
    }).status).toBe(1);
  });
}

test('both existing flows use the shared setup only in local-only mode', () => {
  for (const name of ['cc-ci-fix', 'cc-pr-review-responder']) {
    const workflow = Bun.YAML.parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps || []);
    const setup = steps.find((step) => step.id === 'router-key');
    expect(setup.uses).toEndWith('/local-model-setup');
    expect(setup.if).toBe('inputs.local_only');
    expect(steps.some((step) => step.with?.['sparse-checkout']?.includes('.github/actions/local-model-setup'))).toBe(true);
  }
  const key = action.runs.steps[1];
  expect(key.with.exportEnv).toBe(false);
  expect(key.with.exportToken).toBe(false);
});
