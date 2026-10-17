const { expect, test } = require('bun:test');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

const script = join(process.cwd(), '.github', 'scripts', 'pr-agent', 'run.sh');
const rubricFile = join(process.cwd(), 'pr-agent', 'rubric.toml');

// run.sh with a stand-in `docker` first on PATH that prints `output` and
// exits 0, which is what PR-Agent 0.45.0 does whether or not it reviewed.
function runWithDockerPrinting(output) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-agent-run-'));
  try {
    const docker = join(dir, 'docker');
    writeFileSync(docker, `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(output)}\n`);
    chmodSync(docker, 0o755);
    return Bun.spawnSync(['bash', script], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        BASE_URL: 'https://router.invalid/v1',
        API_KEY: 'k',
        JOB_TOKEN: 't',
        MODEL: 'medium',
        JOB_TIMEOUT_MINUTES: '5',
        MAX_TOKENS: '32000',
        RUBRIC_FILE: rubricFile,
        PR_URL: 'https://github.com/o/r/pull/1',
        RUN_REVIEW: 'true',
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runWithDockerSequence(outputs) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-agent-run-'));
  const callsFile = join(dir, 'docker-calls');
  const sleepsFile = join(dir, 'sleep-calls');
  try {
    const docker = join(dir, 'docker');
    const sleep = join(dir, 'sleep');
    const cases = outputs.map((output, index) => {
      const lines = output.split('\n').map((line) => JSON.stringify(line)).join(' ');
      return '    ' + (index + 1) + ") printf '%s\\n' " + lines + ' ;;';
    }).join('\n');
    const dockerScript = [
      '#!/usr/bin/env bash',
      'count=0',
      'if [ -f "$DOCKER_CALLS" ]; then count="$(cat "$DOCKER_CALLS")"; fi',
      'count=$((count + 1))',
      "printf '%s\\n' \"$count\" > \"$DOCKER_CALLS\"",
      'case "$count" in',
      cases,
      '    *) ;;',
      'esac',
      '',
    ].join('\n');
    writeFileSync(docker, dockerScript);
    writeFileSync(sleep, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$SLEEP_CALLS"\n');
    chmodSync(docker, 0o755);
    chmodSync(sleep, 0o755);
    const result = Bun.spawnSync(['bash', script], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: dir + ':' + process.env.PATH,
        BASE_URL: 'https://router.invalid/v1',
        API_KEY: 'k',
        JOB_TOKEN: 't',
        MODEL: 'medium',
        JOB_TIMEOUT_MINUTES: '5',
        MAX_TOKENS: '32000',
        RUBRIC_FILE: rubricFile,
        PR_URL: 'https://github.com/o/r/pull/1',
        RUN_REVIEW: 'true',
        DOCKER_CALLS: callsFile,
        SLEEP_CALLS: sleepsFile,
      },
    });
    return {
      result,
      callCount: Number(readFileSync(callsFile, 'utf8').trim()),
      sleepCalls: existsSync(sleepsFile) ? readFileSync(sleepsFile, 'utf8').trim().split('\n') : [],
      gatewayReason: existsSync(join(dir, 'gateway-reason.txt'))
        ? readFileSync(join(dir, 'gateway-reason.txt'), 'utf8').trim()
        : undefined,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('run.sh fails when PR-Agent logs a failed request', () => {
  const result = runWithDockerPrinting(
    '2026-09-19 20:07:54.285 | ERROR | pr_agent.agent.pr_agent:_handle_request:184 - Failed to process the command.',
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain('::error::pr-agent review failed');
});

test('run.sh retries a connection failure once and continues after success', () => {
  const failedConnection = [
    '2026-09-19 20:07:54.285 | ERROR | pr_agent.agent.pr_agent:_handle_request:184 - Failed to process the command.',
    'connect ECONNRESET 10.0.0.1:4000',
  ].join('\n');
  const run = runWithDockerSequence([
    failedConnection,
    'INFO | pr_agent.tools.pr_reviewer:run:203 - Reviewing PR: done',
  ]);
  expect(run.result.exitCode).toBe(0);
  expect(run.callCount).toBe(2);
  expect(run.sleepCalls).toEqual(['15']);
  expect(run.gatewayReason).toBeUndefined();
});

test('run.sh does not retry a timeout-class failure', () => {
  const failedTimeout = [
    '2026-09-19 20:07:54.285 | ERROR | pr_agent.agent.pr_agent:_handle_request:184 - Failed to process the command.',
    'litellm.Timeout: APITimeoutError - Request timed out. timeout value=90.0',
  ].join('\n');
  const run = runWithDockerSequence([failedTimeout]);
  expect(run.result.exitCode).toBe(0);
  expect(run.callCount).toBe(1);
  expect(run.sleepCalls).toEqual([]);
  expect(run.gatewayReason).toBe('timeout');
});

test('run.sh gives PR-Agent exactly one request per model call', () => {
  // The stand-in docker prints the env file it was handed, so the assertion
  // reads exactly what PR-Agent would.
  const dir = mkdtempSync(join(tmpdir(), 'pr-agent-run-'));
  try {
    const docker = join(dir, 'docker');
    writeFileSync(docker, '#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do case "$1" in --env-file) cat "$2"; shift 2 ;; --env) printf "docker-env=%s\\n" "$2"; shift 2 ;; *) shift ;; esac; done\nprintf "reviewer=%s\\n" "$PR_REVIEWER__EXTRA_INSTRUCTIONS"\nprintf "suggestions=%s\\n" "$PR_CODE_SUGGESTIONS__EXTRA_INSTRUCTIONS"\n');
    chmodSync(docker, 0o755);
    const result = Bun.spawnSync(['bash', script], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        BASE_URL: 'https://router.invalid/v1',
        API_KEY: 'k',
        JOB_TOKEN: 't',
        MODEL: 'medium',
        JOB_TIMEOUT_MINUTES: '5',
        MAX_TOKENS: '32000',
        RUBRIC_FILE: rubricFile,
        PR_URL: 'https://github.com/o/r/pull/1',
        RUN_REVIEW: 'true',
      },
    });
    const env = result.stdout.toString();
    expect(env).toContain('CONFIG__AI_TIMEOUT=240\n');
    expect(env).toContain('CONFIG__RETRY_SAME_MODEL_ON_TIMEOUT=false\n');
    expect(env).toContain('CONFIG__NUM_RETRIES=0\n');
    expect(env).toContain('docker-env=OPENAI__KEY');
    expect(env).toContain('docker-env=OPENAI__API_BASE');
    expect(env).toContain('docker-env=GITHUB__USER_TOKEN');
    expect(env).not.toContain('OPENAI__KEY=k');
    expect(env).not.toContain('OPENAI__API_BASE=https://router.invalid/v1');
    expect(env).not.toContain('GITHUB__USER_TOKEN=t');
    expect(env).toContain('docker-env=PR_REVIEWER__EXTRA_INSTRUCTIONS');
    expect(env).toContain('docker-env=PR_CODE_SUGGESTIONS__EXTRA_INSTRUCTIONS');
    expect(env).toContain('Is every third-party `uses:` pinned to a full commit SHA');
    expect(env).toContain('Suggest simplifications only:');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run.sh passes when PR-Agent reviewed', () => {
  const result = runWithDockerPrinting('INFO | pr_agent.tools.pr_reviewer:run:203 - Reviewing PR: done');
  expect(result.exitCode).toBe(0);
});
