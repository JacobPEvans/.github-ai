const { expect, test } = require('bun:test');
const { spawnSync } = require('child_process');
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'ai-merge-gate.json'), 'utf8'));
const workflow = (name) => Bun.YAML.parse(readFileSync(join('.github', 'workflows', name), 'utf8'));
const frontdoor = workflow('ai-merge-gate.yml');
const gate = workflow('_ai-merge-gate.yml');

test('the OIDC entry is the same graph with id-token: write on each review job only', () => {
  const oidc = workflow('_ai-merge-gate-oidc.yml');
  const reviews = ['leak', 'security', 'semantic', 'code'];
  for (const job of reviews) {
    expect(gate.jobs[job].permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
    expect(oidc.jobs[job].permissions).toEqual({ contents: 'read', 'id-token': 'write', 'pull-requests': 'write' });
  }
  const withoutIdToken = structuredClone(oidc.jobs);
  for (const job of reviews) delete withoutIdToken[job].permissions['id-token'];
  for (const job of ['gitleaks', 'router', 'gate']) {
    expect(withoutIdToken[job]['runs-on']).toBe("${{ inputs.runner_label || 'ubuntu-26.04' }}");
    withoutIdToken[job]['runs-on'] = gate.jobs[job]['runs-on'];
  }
  expect(withoutIdToken).toEqual(gate.jobs);

  const normalizeRunnerDefault = (workflow) => {
    const normalized = structuredClone(workflow.on);
    normalized.workflow_call.inputs.runner_label.default = '<runner default>';
    normalized.workflow_call.inputs.runner_label.description = '<runner description>';
    return normalized;
  };
  expect(normalizeRunnerDefault(oidc)).toEqual(normalizeRunnerDefault(gate));
  expect(oidc.permissions).toEqual(gate.permissions);
  expect(oidc.concurrency).toEqual(gate.concurrency);
  expect(JSON.stringify(gate)).not.toContain('id-token');
});

test('the public workflow starts the gate for the required pull request events and passes named secrets', () => {
  expect(frontdoor.on.pull_request.types).toEqual(fixture.pull_request_types);
  expect(frontdoor.jobs.gate.with.runner_label).toContain("&& 'review' || 'ubuntu-latest'");
  expect(Object.keys(frontdoor.jobs.gate.secrets).sort()).toEqual([...fixture.router_secrets, 'GH_APP_CLAUDE_BOT_PRIVATE_KEY', 'GITLEAKS_LICENSE_KEY', 'NTFY_BASE_URL'].sort());
});

test('the reusable workflow exposes router and check credentials to its caller', () => {
  const call = gate.on.workflow_call;
  expect(call.inputs.runner_label.default).toBe('ubuntu-24.04');
  expect(fixture.router_secrets.every((name) => call.secrets[name].required === false)).toBe(true);
  expect(call.secrets.NTFY_BASE_URL.required).toBe(false);
  expect(call.secrets.GH_APP_CLAUDE_BOT_PRIVATE_KEY.required).toBe(false);
});

test('the OIDC entry defaults hosted jobs to Ubuntu 26.04 and forwards runner overrides', () => {
  const oidc = workflow('_ai-merge-gate-oidc.yml');
  expect(oidc.on.workflow_call.inputs.runner_label.default).toBe('ubuntu-26.04');
  expect(oidc.on.workflow_call.inputs.runner_label.description).toContain('ubuntu-26.04');

  for (const job of ['gitleaks', 'router', 'gate']) {
    expect(oidc.jobs[job]['runs-on']).toBe("${{ inputs.runner_label || 'ubuntu-26.04' }}");
  }
  for (const job of ['leak', 'security', 'semantic', 'code']) {
    expect(oidc.jobs[job].with.runner_label).toBe('$' + '{{ inputs.runner_label }}');
  }

  const source = readFileSync(join('.github', 'workflows', '_ai-merge-gate-oidc.yml'), 'utf8');
  expect(source).toMatch(/_ai-merge-gate-oidc\.yml@[0-9a-f]{40} # v2\.\d+\.\d+\n/);
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

test('the code review is advisory and the final check does not wait for it', () => {
  const review = gate.jobs.code;
  expect(review.uses).toBe('./.github/workflows/policy-gate.yml');
  expect(review.with).toMatchObject({ rubric: 'code', model: 'standard', blocking: false });
  expect(review.if).toBe(gate.jobs.semantic.if);
  expect(review.secrets).toEqual(gate.jobs.semantic.secrets);
  expect(gate.jobs.gate.needs).not.toContain('code');
});

test('the leak reviews raise only their completion ceiling to 4000 tokens', () => {
  expect(gate.jobs.leak.with.max_tokens).toBe(4000);
  expect(gate.jobs.leak.with).toMatchObject({ model: 'standard', max_diff_kb: 150 });
  expect(gate.jobs.security.with.max_tokens).toBeUndefined();
  expect(gate.jobs.semantic.with.max_tokens).toBeUndefined();
  expect(workflow('dogfood-leak-review.yml').jobs['leak-review'].with).toMatchObject({
    model: 'standard', max_tokens: 4000, max_diff_kb: 150,
  });
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

test('the leak review runs on public repos only', () => {
  expect(gate.jobs.leak.if).toContain('!github.event.repository.private');
  expect(gate.jobs.gitleaks.if ?? '').not.toContain('private');
  expect(gate.jobs.gate.env.REPO_PRIVATE).toBe('$' + '{{ github.event.repository.private }}');
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
        REPO_PRIVATE: String(scenario.private ?? false),
        ROUTER_AVAILABLE: 'true',
        GITLEAKS_RESULT: gitleaks,
        LEAK_RESULT: leak,
        SECURITY_RESULT: security,
        SEMANTIC_RESULT: semantic,
      },
    });
    expect(result.status, scenario.name).toBe(scenario.exit_code);
  }
});

const LABEL_EVENTS = [
  { name: 'push', action: 'synchronize', state: 'open', label: '', mode: 'review' },
  { name: 'override label', action: 'labeled', state: 'open', label: 'security-review-override', mode: 'review' },
  { name: 'override removed', action: 'unlabeled', state: 'open', label: 'policy-gate-override', mode: 'review' },
  { name: 'other label', action: 'labeled', state: 'open', label: 'needs-lead', mode: 'reuse' },
  { name: 'override on a closed PR', action: 'labeled', state: 'closed', label: 'security-review-override', mode: 'reuse' },
];

test('a label event reviews only for an override label on an open pull request', () => {
  const script = gate.jobs.router.steps.find((step) => step.id === 'mode').run;
  const dir = mkdtempSync(join(tmpdir(), 'gate-mode-'));
  for (const event of LABEL_EVENTS) {
    const output = join(dir, `${event.name}.out`);
    const result = spawnSync('/bin/bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        EVENT_ACTION: event.action,
        LABEL_NAME: event.label,
        PR_STATE: event.state,
        GITHUB_OUTPUT: output,
      },
    });
    expect(result.status, event.name).toBe(0);
    expect(readFileSync(output, 'utf8').trim(), event.name).toBe(`mode=${event.mode}`);
  }
  rmSync(dir, { recursive: true, force: true });
  expect(gate.concurrency.group).toContain("endsWith(github.event.label.name, '-override')");
  expect(gate.concurrency.group).toContain("'-reuse'");
});

test('a non-override label event makes no router call and keeps the previous AI Merge Gate conclusion', () => {
  // No router call: in reuse mode the router job reports unavailable, so every review job skips, and so does the scan.
  const probe = gate.jobs.router.steps.find((step) => step.id === 'probe');
  expect(probe.if).toBe("steps.mode.outputs.mode == 'review'");
  expect(gate.jobs.router.outputs.available).toBe("${{ steps.probe.outputs.available || 'false' }}");
  expect(gate.jobs.gitleaks.if).toBe("needs.router.outputs.mode == 'review'");
  expect(gate.jobs.gate.env.MODE).toBe('${{ needs.router.outputs.mode }}');
  for (const job of ['leak', 'security', 'semantic', 'code']) {
    expect([gate.jobs[job].needs].flat(), job).toContain('router');
    expect(gate.jobs[job].if, job).toContain("needs.router.outputs.available == 'true'");
  }
  const final = gate.jobs.gate;
  expect(final.steps[0].if).toBe("env.MODE != 'reuse'");
  expect(final.steps[1].if).toBe("env.MODE != 'reuse'");
  const reuse = final.steps.find((step) => step.if === "env.MODE == 'reuse'");

  const dir = mkdtempSync(join(tmpdir(), 'gate-reuse-'));
  const gh = join(dir, 'gh');
  // The stub answers the check-runs call by applying the step's own --jq filter to $CHECK_RUNS.
  writeFileSync(gh, '#!/bin/bash\nwhile [ "$1" != --jq ]; do shift; done\nprintf %s "$CHECK_RUNS" | jq -r "$2"\n');
  chmodSync(gh, 0o755);
  const run = (conclusion, runId, completed) => ({
    name: 'gate / AI Merge Gate', status: 'completed', conclusion, completed_at: completed,
    details_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });
  const scenarios = [
    ['previous success stands', [run('failure', 10, '2026-11-19T01:00:00Z'), run('success', 11, '2026-11-19T02:00:00Z')], 0],
    ['previous failure stands', [run('success', 10, '2026-11-19T01:00:00Z'), run('failure', 11, '2026-11-19T02:00:00Z')], 1],
    ['this run is ignored', [run('success', 11, '2026-11-19T01:00:00Z'), run('failure', 99, '2026-11-19T03:00:00Z')], 0],
    ['no previous verdict fails closed', [run('success', 99, '2026-11-19T01:00:00Z')], 1],
  ];
  for (const [name, checkRuns, exitCode] of scenarios) {
    const result = spawnSync('/bin/bash', ['-c', reuse.run], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'o/r',
        HEAD_SHA: 'abc',
        RUN_ID: '99',
        CHECK_RUNS: JSON.stringify({ check_runs: checkRuns }),
      },
    });
    expect(result.status, `${name}: ${result.stdout}${result.stderr}`).toBe(exitCode);
  }
  rmSync(dir, { recursive: true, force: true });
});
