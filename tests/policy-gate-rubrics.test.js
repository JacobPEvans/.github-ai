const { expect, test } = require('bun:test');
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

// The rubric input selects one review from policy-gate.yml. Each non-policy
// rubric needs a prompt file whose checks are the ones its review names, and
// one dogfood caller that selects it with the router alias the rubric runs on.
const workflow = (name) => Bun.YAML.parse(readFileSync(join('.github', 'workflows', name), 'utf8'));
const prompt = (name) => Bun.YAML.parse(readFileSync(join('.github', 'scripts', 'policy-gate', `${name}-review.prompt.yml`), 'utf8'));

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

test('leak: secret references alone pass credential while actual values still fail', () => {
  const content = prompt('leak').messages.find(({ role }) => role === 'system').content;
  expect(content).toContain('A GitHub Actions expression such as ${{ secrets.NAME }} names a secret without containing its value; the reference alone passes credential.');
  expect(content).toContain('An actual credential value in an added line still fails, including alongside such a reference.');
});

test('security: required first-party caller permissions pass while broader grants still fail', () => {
  const content = prompt('security').messages.find(({ role }) => role === 'system').content;
  expect(content).toContain('A caller job granting only the permissions required by a called first-party reusable workflow passes permission_widening (for example, pull-requests: write for a workflow that comments on and merges pull requests).');
  expect(content).toContain("Permissions beyond that workflow's needs, write-all, or a new write scope on an unrelated job still fail.");
});

test('semantic: promotion aggregates pass omissions while non-promotions and mismatches remain checked', () => {
  const content = prompt('semantic').messages.find(({ role }) => role === 'system').content;
  expect(content).toContain('For a develop-to-main promotion PR (for example, chore: promote develop to main), omitted_behavior passes for aggregated changes from already-reviewed merged PRs without requiring an itemized list.');
  expect(content).toContain('A non-promotion PR that omits a changed behavior still fails omitted_behavior, and claim_mismatch still applies to every PR.');
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
