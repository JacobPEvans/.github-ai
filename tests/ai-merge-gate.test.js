const { expect, test } = require('bun:test');
const { spawnSync } = require('child_process');
const { readFileSync } = require('fs');
const { join } = require('path');

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'ai-merge-gate.json'), 'utf8'));
const workflow = (name) => Bun.YAML.parse(readFileSync(join('.github', 'workflows', name), 'utf8'));
const frontdoor = workflow('ai-merge-gate.yml');
const gate = workflow('_ai-merge-gate.yml');

test('the public workflow starts the gate for the required pull request events and inherits secrets', () => {
  expect(frontdoor.on.pull_request.types).toEqual(fixture.pull_request_types);
  expect(frontdoor.jobs.gate.secrets).toBe('inherit');
});

test('the reusable workflow exposes router and check credentials to its caller', () => {
  const call = gate.on.workflow_call;
  expect(call.inputs.runner_label.default).toBe('ubuntu-24.04');
  expect(fixture.router_secrets.every((name) => call.secrets[name].required === false)).toBe(true);
  expect(call.secrets.NTFY_BASE_URL.required).toBe(false);
  expect(call.secrets.GH_APP_CLAUDE_BOT_PRIVATE_KEY.required).toBe(false);
});

test('the three policy reviews use dogfood rubrics, models, and blocking mode', () => {
  for (const { job, rubric, model } of fixture.review_jobs) {
    const review = gate.jobs[job];
    expect(review.uses).toBe('./.github/workflows/policy-gate.yml');
    expect(review.with).toMatchObject({ rubric, model, blocking: true });
    for (const name of [...fixture.router_secrets, 'NTFY_BASE_URL', 'GH_APP_CLAUDE_BOT_PRIVATE_KEY']) {
      expect(review.secrets[name]).toBe('$' + '{{ secrets.' + name + ' }}');
    }
  }
});

test('the deterministic scan is pinned and checks out the full pull request head history', () => {
  const scan = gate.jobs.gitleaks;
  expect(scan.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
  const checkout = scan.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  expect(checkout.with).toMatchObject({
    ref: '${{ github.event.pull_request.head.sha }}',
    'fetch-depth': 0,
    'persist-credentials': false,
  });
  expect(scan.steps.some((step) => step.uses === 'gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e')).toBe(true);
});

test('the final check waits for every required job and only accepts draft skips', () => {
  const final = gate.jobs.gate;
  expect(final.needs).toEqual(fixture.required_jobs);
  expect(final.if).toBe('always()');
  expect(final.steps[0].run).toContain('copilot');
  const script = final.steps[1].run;
  expect(script).toContain('failure|cancelled)');
  expect(script).toContain('skipped)');
  expect(script).toContain('IS_DRAFT');
  expect(script).toContain('unexpected conclusion');

  for (const scenario of fixture.gate_scenarios) {
    const [gitleaks, leak, security, semantic] = scenario.results;
    const result = spawnSync('/bin/bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        IS_DRAFT: String(scenario.draft),
        GITLEAKS_RESULT: gitleaks,
        LEAK_RESULT: leak,
        SECURITY_RESULT: security,
        SEMANTIC_RESULT: semantic,
      },
    });
    expect(result.status, scenario.name).toBe(scenario.exit_code);
  }
});
