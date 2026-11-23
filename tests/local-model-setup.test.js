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

test('local-only validation reports every missing setting in one run', () => {
  const run = spawnSync('bash', ['-e', '-c', validate.run], {
    env: { ...valid, OPENBAO_ADDR: '', OTEL_ENDPOINT: '' },
    encoding: 'utf8',
  });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('OPENBAO_ADDR is required');
  expect(run.stderr).toContain('AI_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is required');
});

for (const limit of ['0', '-1', 'abc', '00', '000', '9007199254740992', '99999999999999999999']) {
  test(`local-only validation rejects limit ${limit}`, () => {
    expect(spawnSync('bash', ['-e', '-c', validate.run], {
      env: { ...valid, DAILY_RUN_LIMIT: limit },
    }).status).toBe(1);
  });
}

test('local-only validation accepts limit 05', () => {
  expect(spawnSync('bash', ['-e', '-c', validate.run], {
    env: { ...valid, DAILY_RUN_LIMIT: '05' },
  }).status).toBe(0);
});

test('local-only validation accepts limit 9007199254740991', () => {
  expect(spawnSync('bash', ['-e', '-c', validate.run], {
    env: { ...valid, DAILY_RUN_LIMIT: '9007199254740991' },
  }).status).toBe(0);
});

test('local-only validation accepts limit 0009007199254740991', () => {
  expect(spawnSync('bash', ['-e', '-c', validate.run], {
    env: { ...valid, DAILY_RUN_LIMIT: '0009007199254740991' },
  }).status).toBe(0);
});

test('local-only validation reports one message for limit 99999999999999999999', () => {
  const run = spawnSync('bash', ['-e', '-c', validate.run], {
    env: { ...valid, DAILY_RUN_LIMIT: '99999999999999999999' },
    encoding: 'utf8',
  });
  expect(run.status).toBe(1);
  expect(run.stderr.split('daily_run_limit must be').length - 1).toBe(1);
});

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

test('the router key read asks GitHub for the calling owner audience', () => {
  const read = action.runs.steps.find((step) => step.uses?.startsWith('hashicorp/vault-action@'));
  expect(read.with.jwtGithubAudience).toBe('https://github.com/${{ github.repository_owner }}');
});
