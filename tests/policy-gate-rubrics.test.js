const { expect, test } = require('bun:test');
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

// The rubric input selects one review from policy-gate.yml. Each non-policy
// rubric needs a prompt file whose checks are the ones its review names, and
// one dogfood caller that selects it with the router alias the rubric runs on.
const workflow = (name) => Bun.YAML.parse(readFileSync(join('.github', 'workflows', name), 'utf8'));
const prompt = (name) => Bun.YAML.parse(readFileSync(join('.ai-llm-prompts', 'automation', `ai-workflows-${name}-review.prompt.yml`), 'utf8'));
const policyGate = workflow('policy-gate.yml');

const rubrics = {
  security: {
    prompt: 'security-review',
    model: 'critical',
    checks: ['auth', 'injection', 'permission_widening', 'unsafe_trigger', 'secret_handling'],
  },
  leak: {
    prompt: 'leak-review',
    model: 'standard',
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

test('policy-gate.yml passes the selected rubric to the collector', () => {
  const collect = workflow('policy-gate.yml').jobs.review.steps.find(({ name }) => name === 'Collect the diff and file sizes');
  expect(collect.env.RUBRIC).toBe('${{ inputs.rubric }}');
});

function enforcementMode(rubric, today, blocking = true) {
  const step = policyGate.jobs.gate.steps.find(({ id }) => id === 'enforcement');
  const dir = mkdtempSync(join(tmpdir(), 'policy-gate-enforcement-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const date = join(bin, 'date');
    writeFileSync(date, '#!/bin/sh\nprintf \'%s\\n\' "$FAKE_TODAY"\n');
    chmodSync(date, 0o755);
    const output = join(dir, 'step-output');
    const result = Bun.spawnSync(['/bin/bash', '-c', step.run], {
      cwd: dir,
      env: {
        ...process.env,
        RUBRIC: rubric,
        BLOCKING: String(blocking),
        LEAK_ADVISORY_END_DATE: policyGate.env.LEAK_ADVISORY_END_DATE,
        FAKE_TODAY: today,
        GITHUB_OUTPUT: output,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return readFileSync(output, 'utf8').trim().split('=')[1];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function conclusionFor(reviewName, blocking) {
  const step = policyGate.jobs.gate.steps.find(({ name }) => name === 'Post the verdict check run');
  const dir = mkdtempSync(join(tmpdir(), 'policy-gate-conclusion-'));
  try {
    const helperDir = join(dir, '.ai-workflows', '.github', 'scripts', 'shared');
    mkdirSync(helperDir, { recursive: true });
    const helper = join(helperDir, 'check-run.sh');
    const conclusion = join(dir, 'conclusion');
    writeFileSync(helper, '#!/bin/sh\nprintf \'%s\\n\' "$3" > "$CHECK_CONCLUSION_FILE"\n');
    chmodSync(helper, 0o755);
    writeFileSync(join(dir, 'policy-gate.exit'), '1\n');
    const result = Bun.spawnSync(['/bin/bash', '-c', step.run], {
      cwd: dir,
      env: {
        ...process.env,
        REVIEW_NAME: reviewName,
        BLOCKING: String(blocking),
        CHECK_HEAD_SHA: 'a'.repeat(40),
        CHECK_CONCLUSION_FILE: conclusion,
      },
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return readFileSync(conclusion, 'utf8').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the leak deadline is one UTC value shared by enforcement and the report', () => {
  expect(policyGate.env.LEAK_ADVISORY_END_DATE).toBe('2026-11-23');

  const enforcement = policyGate.jobs.gate.steps.find(({ id }) => id === 'enforcement');
  const render = policyGate.jobs.gate.steps.find(({ name }) => name === 'Render the verdict');
  const check = policyGate.jobs.gate.steps.find(({ name }) => name === 'Post the verdict check run');
  const enforce = policyGate.jobs.gate.steps.find(({ name }) => name === 'Enforce the verdict');
  const renderer = readFileSync(join('.github', 'scripts', 'policy-gate', 'render.sh'), 'utf8');

  expect(enforcement.run).toContain('$LEAK_ADVISORY_END_DATE');
  expect(render.env.RUBRIC).toBe('${{ inputs.rubric }}');
  expect(renderer).toContain('${LEAK_ADVISORY_END_DATE:?');
  expect(check.env.BLOCKING).toBe('${{ steps.enforcement.outputs.blocking }}');
  expect(enforce.if).toContain("steps.enforcement.outputs.blocking == 'true'");
});

test('a leak finding is neutral before the deadline and fails on the deadline', () => {
  const before = enforcementMode('leak', '2026-11-22');
  const after = enforcementMode('leak', '2026-11-23');

  expect(before).toBe('false');
  expect(conclusionFor('leak-review', before)).toBe('neutral');
  expect(after).toBe('true');
  expect(conclusionFor('leak-review', after)).toBe('failure');
});

test.each(['security', 'semantic'])('%s findings still fail when blocking', (rubric) => {
  const blocking = enforcementMode(rubric, '2026-11-22');
  expect(blocking).toBe('true');
  expect(conclusionFor(`${rubric}-review`, blocking)).toBe('failure');
});

test('the leak report states the same UTC date used by enforcement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-gate-leak-report-'));
  try {
    const response = join(dir, 'response.json');
    writeFileSync(response, JSON.stringify({
      summary: 'One finding.',
      findings: [{ check: 'private_host_or_ip', result: 'fail', file: 'config.yml', line: 1, detail: 'Finding.' }],
    }));
    const result = Bun.spawnSync(['bash', join(process.cwd(), '.github', 'scripts', 'policy-gate', 'render.sh')], {
      cwd: dir,
      env: {
        ...process.env,
        RESPONSE_FILE: response,
        MODEL: 'light',
        RUBRIC: 'leak',
        REVIEW_TITLE: 'Leak review',
        LEAK_ADVISORY_END_DATE: policyGate.env.LEAK_ADVISORY_END_DATE,
      },
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const report = readFileSync(join(dir, 'policy-gate.md'), 'utf8');
    expect(report).toContain(`advisory before \`${policyGate.env.LEAK_ADVISORY_END_DATE}\` UTC`);
    expect(report).toContain('fail on and after that date');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('leak: secret references alone pass credential while actual values still fail', () => {
  const content = prompt('leak').messages.find(({ role }) => role === 'system').content;
  expect(content).toContain('Each GitHub Actions secret expression arrives already rewritten as <secret-reference:NAME>.');
  expect(content).toContain('the reference alone passes credential, including on a line such as API_KEY: <secret-reference:API_KEY>.');
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
    const promptPath = join('.ai-llm-prompts', 'automation', `ai-workflows-${spec.prompt}.prompt.yml`);
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
