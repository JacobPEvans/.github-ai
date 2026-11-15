const { expect, test } = require('bun:test');
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

// cc-pr-review-responder's agent job reads review text, which is untrusted. Only the jobs
// that write (publish, and the gateway report) may hold the App key or the App id.
const file = join('.github', 'workflows', 'cc-pr-review-responder.yml');
const workflow = Bun.YAML.parse(readFileSync(file, 'utf8'));
const APP_REFS = ['GH_APP_CLAUDE_BOT_PRIVATE_KEY', 'GH_APP_CLAUDE_BOT_ID'];

const mentionsApp = (node) => {
  const text = JSON.stringify(node);
  return APP_REFS.some((ref) => text.includes(ref));
};

const stepIndex = (job, name) => job.steps.findIndex((step) => step.name === name);

test('the agent job holds neither the App key nor the App id', () => {
  expect(mentionsApp(workflow.jobs.respond)).toBe(false);
});

test('the agent job requests only read scopes', () => {
  for (const [scope, level] of Object.entries(workflow.jobs.respond.permissions)) {
    expect(level, scope).toBe('read');
  }
});

test('only the write jobs reference the App key or the App id', () => {
  const holders = Object.entries(workflow.jobs)
    .filter(([, job]) => mentionsApp(job))
    .map(([name]) => name)
    .sort();
  expect(holders).toEqual(['publish', 'report-gateway']);
});

test('the agent job exposes the gateway class to the gateway report job', () => {
  expect(workflow.jobs.respond.outputs.gateway_class).toBe('${{ steps.agent.outputs.gateway_class }}');
  expect(workflow.jobs['report-gateway'].needs).toContain('respond');
  expect(workflow.jobs['report-gateway'].if).toContain('needs.respond.outputs.gateway_class');
});

test('the publish job validates the patch before applying it', () => {
  const validate = stepIndex(workflow.jobs.publish, 'Validate agent patch');
  const apply = stepIndex(workflow.jobs.publish, 'Apply agent patch');
  expect(validate).toBeGreaterThanOrEqual(0);
  expect(validate).toBeLessThan(apply);
  expect(workflow.jobs.publish.steps[validate].run).toContain('.ai-workflows');
});

test('the tooling checkout is unchanged after the patch is applied, and before the App token is minted', () => {
  const publish = workflow.jobs.publish;
  const check = stepIndex(publish, 'Verify the tooling checkout is unchanged');
  expect(check).toBeGreaterThan(stepIndex(publish, 'Apply agent patch'));
  expect(check).toBeLessThan(stepIndex(publish, 'Mint commit token'));
  const run = publish.steps[check].run;

  // A nested repository stands in for the .ai-workflows checkout; the patch is a real git patch.
  const dir = mkdtempSync(join(tmpdir(), 'tooling-checkout-'));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (args, cwd) => Bun.spawnSync(['git', ...args], { cwd, env });
  const check_ = (cwd) => Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', run], { cwd, env }).exitCode;
  try {
    const tooling = join(dir, '.ai-workflows');
    mkdirSync(join(tooling, '.github'), { recursive: true });
    writeFileSync(join(tooling, '.github', 'x.js'), 'a\n');
    git(['init', '-q'], tooling);
    git(['add', '-A'], tooling);
    git(['commit', '-qm', 'fix: seed'], tooling);
    git(['init', '-q'], dir);

    expect(check_(dir)).toBe(0);

    writeFileSync(
      join(dir, 'agent.patch'),
      'diff --git a/.ai-workflows/.github/x.js b/.ai-workflows/.github/x.js\n' +
        '--- a/.ai-workflows/.github/x.js\n' +
        '+++ b/.ai-workflows/.github/x.js\n' +
        '@@ -1 +1,2 @@\n a\n+evil\n',
    );
    expect(git(['apply', 'agent.patch'], dir).exitCode).toBe(0);
    expect(check_(dir)).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the commit step leaves the review handoff file out of the commit', () => {
  // The handoff is downloaded into the workspace root before the commit; without an exclude
  // the commit helper stages it as an untracked file.
  const commit = workflow.jobs.publish.steps.find((step) => step.name === 'Commit fixes to PR branch');
  expect(commit.env.EXTRA_EXCLUDES).toBe('.review-actions.json');
});

test('the patch check matches the tooling path case-insensitively', () => {
  // On a case-insensitive filesystem, .AI-WORKFLOWS names the same checkout.
  const run = workflow.jobs.publish.steps[stepIndex(workflow.jobs.publish, 'Validate agent patch')].run;
  expect(run).toMatch(/grep -q[a-zA-Z]*i[a-zA-Z]* /);
});

test('the patch check rejects a tooling path in either operand of a diff header', () => {
  // Runs the pattern the workflow really uses against sample patch header lines.
  const run = workflow.jobs.publish.steps[stepIndex(workflow.jobs.publish, 'Validate agent patch')].run;
  const pattern = run.match(/grep -qiE '([^']*)'/)[1];
  const matches = (line) =>
    Bun.spawnSync(['grep', '-qiE', pattern], { stdin: Buffer.from(`${line}\n`) }).exitCode === 0;
  const tooling = [
    'diff --git a/.ai-workflows/x b/.ai-workflows/x',
    'diff --git a/.AI-WORKFLOWS/x b/.AI-WORKFLOWS/x',
    'diff --git a/src/x b/.ai-workflows/x',
    '--- a/.AI-WORKFLOWS/x',
    'rename to .ai-workflows/moved.txt',
    'diff --git a/src/.AI-WORKFLOWS/x b/src/.AI-WORKFLOWS/x',
    '--- a/src/.ai-workflows/x',
    '+++ b/src/.ai-workflows/x',
    'rename to src/sub/.ai-workflows/x',
  ];
  const ordinary = [
    'diff --git a/src/x b/src/x',
    '+++ b/src/x',
    'rename from src/old.txt',
    'diff --git a/src/x-ai-workflows/y b/src/x-ai-workflows/y',
  ];
  for (const line of tooling) expect(matches(line), line).toBe(true);
  for (const line of ordinary) expect(matches(line), line).toBe(false);
});

// --- R08: the responder acts only on a CHANGES verdict, in the shared writer group ---

const gateStep = () => workflow.jobs.respond.steps.find((step) => step.id === 'verdict');

// Runs the real gate step script with a stubbed `gh` (the network call) while keeping the
// real `jq` filter and the real shell retry/output logic. `sleep` is stubbed so the
// fail-closed retry path is instant. Requires `jq` on PATH (as `gh` embeds it).
const runGate = (checkRuns, { ghFails = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-gate-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const payload = join(dir, 'check-runs.json');
    writeFileSync(payload, JSON.stringify({ check_runs: checkRuns }));
    const outputFile = join(dir, 'github-output');
    writeFileSync(outputFile, '');
    const gh = join(bin, 'gh');
    writeFileSync(
      gh,
      [
        '#!/usr/bin/env bash',
        'filter=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--jq" ]; then filter="$arg"; fi',
        '  prev="$arg"',
        'done',
        'if [ -n "$GH_FAIL" ]; then exit 1; fi',
        'exec jq -r "$filter" "$PAYLOAD"',
        '',
      ].join('\n'),
    );
    chmodSync(gh, 0o755);
    const sleep = join(bin, 'sleep');
    writeFileSync(sleep, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(sleep, 0o755);
    const script = gateStep().run.replaceAll('${{ github.repository }}', 'owner/repo');
    const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', script], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HEAD_SHA: '0123456789abcdef0123456789abcdef01234567',
        GITHUB_OUTPUT: outputFile,
        PAYLOAD: payload,
        GH_FAIL: ghFails ? '1' : '',
      },
    });
    const output = readFileSync(outputFile, 'utf8');
    const changes = (output.match(/^changes=(.*)$/m) || [])[1];
    return { exitCode: result.exitCode, changes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('the responder shares the pr-writer concurrency group and never cancels in progress', () => {
  expect(workflow.concurrency.group).toBe(
    'pr-writer-${{ github.repository }}-${{ github.event.pull_request.number || inputs.pr_number || github.run_id }}',
  );
  expect(workflow.concurrency['cancel-in-progress']).toBe(false);
});

test('the verdict gate reads the AI Merge Gate check-run on the head before any checkout or agent work', () => {
  const respond = workflow.jobs.respond;
  const gate = respond.steps.findIndex((step) => step.id === 'verdict');
  const resolve = respond.steps.findIndex((step) => step.id === 'pr');
  expect(gate).toBeGreaterThanOrEqual(0);
  // Only the dispatch-only head resolution (which supplies the head SHA) may precede it.
  expect(gate).toBe(resolve + 1);
  expect(gate).toBeLessThan(stepIndex(respond, 'Checkout PR head'));
  expect(gate).toBeLessThan(stepIndex(respond, 'Run AI agent'));
  const step = respond.steps[gate];
  expect(step.env.HEAD_SHA).toBe('${{ github.event.pull_request.head.sha || steps.pr.outputs.sha }}');
  expect(step.run).toContain('/check-runs');
  expect(step.run).toContain('AI Merge Gate');
  expect(step.run).toContain('VERDICT: CHANGES');
  expect(step.run).toContain('changes=');
});

test('the agent, its handoff, and publish act only on a CHANGES verdict', () => {
  const respond = workflow.jobs.respond;
  expect(respond.outputs.changes).toBe('${{ steps.verdict.outputs.changes }}');
  for (const name of ['Run AI agent', 'Collect agent patch', 'Upload responder handoff']) {
    const step = respond.steps.find((s) => s.name === name);
    expect(step.if, name).toBe("steps.verdict.outputs.changes == 'true'");
  }
  expect(workflow.jobs.publish.if).toContain("needs.respond.outputs.changes == 'true'");
  expect(workflow.jobs.publish.if).toContain('!inputs.dry_run');
});

test('the fork and loop guards on the agent job are preserved', () => {
  const cond = workflow.jobs.respond.if;
  expect(cond).toContain("needs.check-daily-limit.outputs.should_run == 'true'");
  expect(cond).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  expect(cond).toContain("github.event.sender.login != 'jacobpevans-claude[bot]'");
  expect(cond).toContain("github.event.sender.login != 'claude[bot]'");
  expect(cond).toContain("github.event.sender.login != 'github-actions[bot]'");
});

test('the verdict gate sets changes=true only for a CHANGES summary on the AI Merge Gate check-run', () => {
  const checkRun = (name, summary) => ({ name, output: { summary } });
  expect(runGate([checkRun('AI Merge Gate', 'VERDICT: CHANGES')]).changes).toBe('true');
  expect(runGate([checkRun('AI Merge Gate', 'Review done.\nVERDICT: CHANGES\nSee threads.')]).changes).toBe('true');
  expect(runGate([checkRun('AI Merge Gate', 'VERDICT: MERGE')]).changes).toBe('false');
  expect(runGate([checkRun('AI Merge Gate', 'VERDICT: DEFERRED')]).changes).toBe('false');
  expect(runGate([checkRun('AI Merge Gate', null)]).changes).toBe('false');
  expect(runGate([checkRun('some other check', 'VERDICT: CHANGES')]).changes).toBe('false');
  expect(runGate([]).changes).toBe('false');
});

test('the verdict gate fails closed when the check-runs API is unreadable', () => {
  const result = runGate([], { ghFails: true });
  expect(result.exitCode).toBe(0);
  expect(result.changes).toBe('false');
});
