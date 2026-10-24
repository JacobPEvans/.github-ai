const { expect, test } = require('bun:test');
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

// The rubric input selects one review from policy-gate.yml. Each non-policy
// rubric needs a prompt file whose checks are the ones its review names, and
// one dogfood caller that selects it with the router alias the rubric runs on.
const workflow = (name) => Bun.YAML.parse(readFileSync(join('.github', 'workflows', name), 'utf8'));

const rubrics = {
  security: {
    prompt: 'security-review',
    model: 'critical',
    checks: ['auth', 'injection', 'permission_widening', 'unsafe_trigger', 'secret_handling'],
  },
  leak: {
    prompt: 'leak-review',
    model: 'light',
    checks: ['credential', 'private_host_or_ip', 'internal_topology', 'incident_detail'],
  },
  semantic: {
    prompt: 'semantic-review',
    model: 'standard',
    checks: ['claim_mismatch', 'omitted_behavior'],
  },
};

test('policy-gate.yml takes a rubric input that defaults to policy', () => {
  const input = workflow('policy-gate.yml').on.workflow_call.inputs.rubric;
  expect(input.type).toBe('string');
  expect(input.default).toBe('policy');
});

test('policy-gate.yml validates the rubric against every rubric it supports', () => {
  const text = readFileSync(join('.github', 'workflows', 'policy-gate.yml'), 'utf8');
  expect(text).toContain('printf \'%s\\n\' policy security leak semantic');
});

for (const [rubric, spec] of Object.entries(rubrics)) {
  test(`${rubric}: its prompt file has the expected checks`, () => {
    const promptPath = join('.github', 'scripts', 'policy-gate', `${spec.prompt}.prompt.yml`);
    expect(existsSync(promptPath)).toBe(true);
    const config = Bun.YAML.parse(readFileSync(promptPath, 'utf8'));
    const schema = JSON.parse(config.jsonSchema);
    expect(schema.schema.properties.findings.items.properties.check.enum).toEqual(spec.checks);
  });

  test(`${rubric}: a dogfood caller selects the rubric and its router alias`, () => {
    const caller = workflow(`dogfood-${rubric}-review.yml`);
    const job = Object.values(caller.jobs)[0];
    expect(job.uses).toBe('./.github/workflows/policy-gate.yml');
    expect(job.with).toMatchObject({ rubric, model: spec.model });
  });
}
