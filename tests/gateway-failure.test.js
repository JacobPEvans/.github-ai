const { describe, expect, it } = require('bun:test');
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const script = join('.github', 'scripts', 'shared', 'gateway-failure.sh');

// A stand-in for gh: records the request body and answers the check-run POST.
// FAKE_GH_MODE=403 reproduces a job that lacks the checks: write grant.
const fakeGh = `#!/usr/bin/env bash
if [ "$1" != api ]; then
  echo "unexpected gh command" >&2
  exit 2
fi
shift
method=GET
if [ "$1" = "-X" ] || [ "$1" = "--method" ]; then
  method="$2"
  shift 2
fi
path="$1"
shift
if [ "$method" = GET ]; then
  echo '{"check_runs":[]}'
  exit 0
fi
cat > "$FAKE_GH_RECORD"
if [ "\${FAKE_GH_MODE:-ok}" = "403" ]; then
  echo "gh: Resource not accessible by integration (HTTP 403)" >&2
  exit 1
fi
echo '{"id":1}'
`;

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-failure-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), fakeGh);
  chmodSync(join(bin, 'gh'), 0o755);
  return { dir, bin, summary: join(dir, 'summary.md'), record: join(dir, 'request.json') };
}

function classify(text) {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-failure-'));
  const file = join(dir, 'input.txt');
  writeFileSync(file, text);
  const result = Bun.spawnSync(['bash', script, 'classify', file]);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

function report(env, { mode = 'ok', job = 'demo', reason = 'rate-limited' } = {}) {
  const w = workdir();
  const result = Bun.spawnSync(['bash', script, 'report', job, reason], {
    env: {
      PATH: `${w.bin}:${process.env.PATH}`,
      GITHUB_STEP_SUMMARY: w.summary,
      FAKE_GH_RECORD: w.record,
      FAKE_GH_MODE: mode,
      GITHUB_REPOSITORY: 'dryvist/example',
      GITHUB_TOKEN: 'token-for-test',
      CHECK_HEAD_SHA: 'abc123',
      CHECK_APP_SLUG: 'review-bot',
      ...env,
    },
  });
  const request = (() => {
    try {
      return JSON.parse(readFileSync(w.record, 'utf8'));
    } catch {
      return undefined;
    }
  })();
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    summary: readFileSync(w.summary, 'utf8'),
    request,
  };
}

describe('gateway failure classification', () => {
  it('names the budget, fallback, rate and connection classes', () => {
    expect(classify('Error: Budget has been exceeded for this key')).toBe('budget-exceeded');
    expect(classify('No fallback model group found for role medium')).toBe('no-fallback-model');
    expect(classify('API Error: 429 Too Many Requests')).toBe('rate-limited');
    expect(classify('connect ECONNREFUSED 10.0.0.1:4000')).toBe('connection');
    expect(classify('litellm.Timeout: APITimeoutError - Request timed out. timeout value=90.0')).toBe('timeout');
  });

  it('names the OpenRouter budget wording and router 5xx errors', () => {
    expect(classify('Budget limit exceeded (monthly limit). $25.05 of $25.00 used')).toBe('budget-exceeded');
    expect(classify('litellm.BadGatewayError: OpenAIException - Error code: 502')).toBe('gateway-error');
    expect(classify('503 Service Unavailable')).toBe('gateway-error');
    expect(classify('504 Gateway Timeout')).toBe('gateway-error');
  });

  it('classifies Claude Code router authentication refusals', () => {
    expect(classify('Failed to authenticate. API Error: 401 Unauthorized')).toBe('router-refused');
  });

  it('classifies the router model-key scope refusal', () => {
    expect(classify("Failed to authenticate. API Error: 403 The requested model 'review-oss' is not available for this API key")).toBe('router-refused');
  });

  it('leaves the key-scope wording unclassified outside the client error line', () => {
    expect(classify("Tool output: The requested model 'review-oss' is not available for this API key")).toBe('');
  });

  it('classifies LiteLLM authentication and permission refusals', () => {
    expect(classify('litellm.AuthenticationError: Authentication failed')).toBe('router-refused');
    expect(classify('litellm.PermissionDeniedError: Permission denied')).toBe('router-refused');
  });

  it('leaves GitHub and tool-output 403 errors unclassified', () => {
    expect(classify('gh: Resource not accessible by integration (HTTP 403)')).toBe('');
    expect(classify('Tool output: request failed with status 403')).toBe('');
    expect(classify('Tool output: API returned HTTP 403 Forbidden')).toBe('');
    expect(classify('Tool output: API Error: 403 Forbidden')).toBe('');
    expect(classify('git: Failed to authenticate with the remote')).toBe('');
  });

  it('matches the router wording for a model group with no fallback', () => {
    expect(
      classify("model group 'medium' failed with the error above and no fallback model group was found for it"),
    ).toBe('no-fallback-model');
  });

  it('leaves a real request error unclassified so the job still fails', () => {
    expect(classify('400 Bad Request: prompt is malformed')).toBe('');
  });

  it('does not match 429 inside a longer number', () => {
    expect(classify('finished in 1429ms')).toBe('');
  });
});

describe('verdict truncation', () => {
  function truncated(text) {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-failure-'));
    const file = join(dir, 'verdict.json');
    writeFileSync(file, text);
    const result = Bun.spawnSync(['bash', script, 'truncated', file]);
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  }

  it('names a verdict cut off mid-string', () => {
    expect(truncated('{"summary":"Found one","findings":[{"check":"credential","result":"fail","file":"a.yml","line":3,"detail":"Unfinished')).toBe('truncated');
  });

  it('does not call an empty verdict truncated', () => {
    expect(truncated('')).toBe('');
  });

  it('does not call unrelated invalid JSON truncated', () => {
    expect(truncated('{"summary":]')).toBe('');
  });

  it('names a completion that stopped at the output limit', () => {
    expect(truncated('{"choices":[{"finish_reason":"length","message":{"content":"{}"}}]}')).toBe('truncated');
  });

  it('passes a complete verdict, including one whose text quotes a length finish reason', () => {
    expect(truncated('{"summary":"No issues.","findings":[]}')).toBe('');
    expect(truncated('{"summary":"finish_reason: length","findings":[]}')).toBe('');
  });

  it('passes a completion that stopped normally', () => {
    expect(truncated('{"choices":[{"finish_reason":"stop","message":{"content":"{}"}}]}')).toBe('');
  });

  it('keeps a length finish reason out of the router classes, so other callers still fail', () => {
    expect(classify('finish_reason: length')).toBe('');
  });
});

describe('gateway failure report', () => {
  it('advisory: posts a neutral check run on the head commit and exits 0', () => {
    const r = report({});
    expect(r.exitCode).toBe(0);
    expect(r.summary).toBe('AI review not performed: gateway unavailable (rate-limited)\n');
    expect(r.stdout).toContain('::warning::demo: AI review not performed');
    expect(r.request.name).toBe('demo: AI review not performed');
    expect(r.request.head_sha).toBe('abc123');
    expect(r.request.conclusion).toBe('neutral');
    expect(r.request.status).toBe('completed');
    expect(r.request.output.summary).toBe('gateway unavailable (rate-limited)');
  });

  it('uses CHECK_NAME when the caller supplies a stable name', () => {
    const r = report({ CHECK_NAME: 'security-review' });
    expect(r.exitCode).toBe(0);
    expect(r.request.name).toBe('security-review');
  });

  it('advisory: reports an agent time bound as a neutral check run', () => {
    const r = report({}, { reason: 'agent-time-bound' });
    expect(r.exitCode).toBe(0);
    expect(r.request.head_sha).toBe('abc123');
    expect(r.request.conclusion).toBe('neutral');
    expect(r.request.output.summary).toBe('gateway unavailable (agent-time-bound)');
  });

  it('uses CHECK_SUMMARY verbatim in the posted check run', () => {
    const summary = 'time-bound: "no review"\\produced';
    const r = report({ CHECK_SUMMARY: summary });
    expect(r.exitCode).toBe(0);
    expect(r.request.output.summary).toBe(summary);
  });

  it('blocking or required: CONCLUSION=failure posts a neutral check run and exits 1', () => {
    const r = report({ CONCLUSION: 'failure' });
    expect(r.exitCode).toBe(1);
    expect(r.request.conclusion).toBe('neutral');
    expect(r.stdout).toContain('::error::demo: AI review not performed');
    expect(r.stdout).toContain('failing closed on a gateway failure');
  });

  it('names the Claude bot App checks: write need when the check run is refused with 403', () => {
    const r = report({}, { mode: '403' });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('::error::demo: the check run was refused with 403');
    expect(r.stdout).toContain('Claude bot App needs checks: write');
  });

  it('advisory: warns and names the cause when no App token exists, and exits 0', () => {
    const r = report({ GITHUB_TOKEN: '', CHECK_TOKEN_CAUSE: 'GH_APP_CLAUDE_BOT_PRIVATE_KEY is not set' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('::warning::demo: cannot post the check run: no Claude bot App token (GH_APP_CLAUDE_BOT_PRIVATE_KEY is not set)');
    expect(r.summary).toBe('AI review not performed: gateway unavailable (rate-limited)\n');
    expect(r.request).toBeUndefined();
  });

  it('blocking or required: stays red and names the cause when no App token exists', () => {
    const r = report({ CONCLUSION: 'failure', GITHUB_TOKEN: '', CHECK_TOKEN_CAUSE: 'GH_APP_CLAUDE_BOT_PRIVATE_KEY is not set' });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('::error::demo: cannot post the check run: no Claude bot App token (GH_APP_CLAUDE_BOT_PRIVATE_KEY is not set)');
    expect(r.request).toBeUndefined();
  });

  it('fails loudly when the head SHA is missing', () => {
    const r = report({ CHECK_HEAD_SHA: '' });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('CHECK_HEAD_SHA and GITHUB_REPOSITORY must be set');
    expect(r.request).toBeUndefined();
  });

  it('skips the ops alert without NTFY_BASE_URL and still writes the summary', () => {
    const r = report({});
    expect(r.stdout).toContain('NTFY_BASE_URL not configured; skipping the ops alert.');
  });

  it('truncated: reports the completion ceiling, never the gateway, as a neutral check run', () => {
    const r = report({}, { reason: 'truncated-response' });
    expect(r.exitCode).toBe(0);
    expect(r.summary).toBe('AI review reply was truncated at the completion ceiling\n');
    expect(r.stdout).toContain('::warning::demo: AI review reply was truncated at the completion ceiling');
    expect(r.stdout).not.toContain('gateway unavailable');
    expect(r.request.conclusion).toBe('neutral');
    expect(r.request.output.summary).toBe('AI review reply was truncated at the completion ceiling');
  });

  it('truncated and blocking: fails closed and names the truncated verdict', () => {
    const r = report({ CONCLUSION: 'failure' }, { reason: 'truncated-response' });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('::error::demo: AI review reply was truncated at the completion ceiling');
    expect(r.stdout).toContain('failing closed on a truncated verdict');
    expect(r.stdout).not.toContain('gateway unavailable');
  });
});

describe('policy-gate verdict state', () => {
  const workflow = Bun.YAML.parse(readFileSync(join('.github', 'workflows', 'policy-gate.yml'), 'utf8'));
  const settle = workflow.jobs.gate.steps.find((step) => step.name === 'Settle the verdict state').run;

  function stateFor(response, validOutcome = 'failure') {
    const dir = mkdtempSync(join(tmpdir(), 'policy-verdict-state-'));
    try {
      const responseFile = join(dir, 'verdict.json');
      const outputFile = join(dir, 'github-output');
      writeFileSync(responseFile, response);
      mkdirSync(join(dir, '.ai-workflows', '.github'), { recursive: true });
      symlinkSync(join(process.cwd(), '.github', 'scripts'), join(dir, '.ai-workflows', '.github', 'scripts'), 'dir');
      const result = Bun.spawnSync(['/bin/bash', '-e', '-o', 'pipefail', '-c', settle], {
        cwd: dir,
        env: {
          ...process.env,
          HAS_OVERRIDE: 'false',
          REVIEW_STATUS: 'ok',
          VALID_OUTCOME: validOutcome,
          RESPONSE_FILE: responseFile,
          GITHUB_OUTPUT: outputFile,
        },
      });
      expect(result.exitCode).toBe(0);
      return readFileSync(outputFile, 'utf8').trim().replace('state=', '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('settles an unterminated verdict as truncated-response', () => {
    expect(stateFor('{"summary":"Found a leak","findings":[{"detail":"unfinished')).toBe('truncated-response');
  });

  it('settles a completion with finish reason length as truncated-response', () => {
    expect(stateFor('{"choices":[{"finish_reason":"length"}]}')).toBe('truncated-response');
  });

  it('keeps a valid verdict in the ok state', () => {
    expect(stateFor('{"summary":"clean","findings":[]}', 'success')).toBe('ok');
  });

  it('keeps structurally valid but schema-invalid JSON as invalid-response', () => {
    expect(stateFor('{"unexpected":true}')).toBe('invalid-response');
  });
});

// Pins the fail-closed and permission wiring, so a later edit cannot quietly
// turn a blocking or required gate green again.
describe('gateway wiring in the workflows', () => {
  const load = (path) => Bun.YAML.parse(readFileSync(join('.github', 'workflows', path), 'utf8'));
  const step = (job, name) => job.steps.find((s) => s.name === name);

  it('sets Claude Code thinking and effort to values accepted by served models', () => {
    const action = Bun.YAML.parse(readFileSync(join('.github', 'actions', 'run-ai-agent', 'action.yml'), 'utf8'));
    const claude = action.runs.steps.find((s) => s.name === 'Run Claude Code');

    expect(claude.env.MAX_THINKING_TOKENS).toBe('0');
    expect(claude.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('medium');
  });

  it('policy-gate: blocking maps to a failure conclusion, and the sticky notice still posts', () => {
    const job = load('policy-gate.yml').jobs.gate;
    const gateway = step(job, 'Report gateway unavailability');
    const mint = step(job, 'Mint the check-run token');
    const verdict = step(job, 'Post the verdict check run');
    expect(gateway.env.CONCLUSION).toContain("inputs.blocking && 'failure'");
    expect(gateway.env.CONCLUSION).toContain("'neutral'");
    expect(gateway.env.CHECK_NAME).toBe('${{ env.REVIEW_NAME }}');
    expect(gateway.env.CHECK_APP_SLUG).toBe('${{ steps.check-token.outputs.app-slug }}');
    expect(gateway.run).toContain('gateway-failure.sh report "$REVIEW_NAME"');
    expect(job.env.REVIEW_NAME).toContain("'policy-gate'");
    expect(mint.if).toBe("steps.state.outputs.state != 'override'");
    expect(verdict.if).toBe("steps.state.outputs.state == 'ok'");
    expect(verdict.run).toContain('check-run.sh update');
    expect(verdict.run).toContain('check-run.sh upsert');
    expect(verdict.run).toContain('policy-gate: cannot update the check run without an App token');
    expect(verdict.run).toContain('|| echo "::warning::policy-gate: could not update the earlier check run"');
    expect(step(job, 'Post sticky comment').if).toContain("steps.gateway.outcome == 'failure'");
    expect(job.permissions).toBeUndefined();
  });

  it('docs-drift is advisory: neutral, and the check run uses the App token, not a caller grant', () => {
    const job = load('docs-drift.yml').jobs.drift;
    expect(step(job, 'Report gateway unavailability').env.CONCLUSION).toBe('neutral');
    expect(step(job, 'Mint the check-run token').with['permission-checks']).toBe('write');
    expect(job.permissions).toEqual({ contents: 'read' });
  });

  it('pr-agent: a gateway failure passes the job and reports neutral; it never blocks a merge', () => {
    const workflow = load('pr-agent.yml');
    const job = workflow.jobs['pr-agent'];
    expect(job.permissions.checks).toBeUndefined();
    const report = step(job, 'Report gateway unavailability');
    expect(report.if).toContain("always() && hashFiles('gateway-reason.txt')");
    expect(report['continue-on-error']).toBe(true);
    expect(report.env.CONCLUSION).toBe('neutral');
    expect(step(job, 'Mint the check-run token').if).toContain("always() && hashFiles('gateway-reason.txt')");
    const runner = readFileSync(join('.github', 'scripts', 'pr-agent', 'run.sh'), 'utf8');
    expect(runner).toMatch(/gateway-reason\.txt\n\s+echo "::warning::.*\n\s+exit 0/);
  });

  it('no callee grants checks: write; the callee GITHUB_TOKEN permissions stay as on main', () => {
    for (const file of [
      'cc-ci-fix.yml',
      'cc-code-simplifier.yml',
      'issue-backlog-sweep.yml',
      'cc-release-notes.yml',
      'docs-drift.yml',
      'pr-agent.yml',
      'policy-gate.yml',
    ]) {
      const workflow = load(file);
      expect(workflow.permissions?.checks).toBeUndefined();
      for (const job of Object.values(workflow.jobs)) {
        expect(job.permissions?.checks).toBeUndefined();
      }
    }
    expect(load('cc-ci-fix.yml').jobs.fix.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
  });

  it('every mint of the check-run token uses the pinned App-token action with checks: write', () => {
    const pinned = 'actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510';
    const action = Bun.YAML.parse(readFileSync(join('.github', 'actions', 'run-ai-agent', 'action.yml'), 'utf8'));
    const sharedMintAction = Bun.YAML.parse(readFileSync(join('.github', 'actions', 'run-ai-agent', 'mint-check-token', 'action.yml'), 'utf8'));
    const directMints = [
      step(load('policy-gate.yml').jobs.gate, 'Mint the check-run token'),
      step(load('docs-drift.yml').jobs.drift, 'Mint the check-run token'),
      step(load('pr-agent.yml').jobs['pr-agent'], 'Mint the check-run token'),
      step(load('cc-release-notes.yml').jobs.highlights, 'Mint the check-run token'),
    ];
    for (const mint of directMints) {
      expect(mint.uses).toBe(pinned);
      expect(mint['continue-on-error']).toBe(true);
      expect(mint.with['permission-checks']).toBe('write');
    }

    const sharedMint = sharedMintAction.runs.steps.find((s) => s.name === 'Mint check-run token');
    expect(sharedMint.uses).toBe(pinned);
    expect(sharedMint.with['permission-checks']).toBe('write');

    const runAiMint = action.runs.steps.find((s) => s.name === 'Mint the check-run token');
    expect(runAiMint.id).toBe('check-token');
    expect(runAiMint.uses).toBe('./.ai-workflows/.github/actions/run-ai-agent/mint-check-token');
    expect(runAiMint['continue-on-error']).toBe(true);
  });

  it('the App key is named as the cause when it is absent', () => {
    const job = load('policy-gate.yml').jobs.gate;
    expect(step(job, 'Report gateway unavailability').env.CHECK_TOKEN_CAUSE).toContain('GH_APP_CLAUDE_BOT_PRIVATE_KEY is not set');
  });

  it('every run-ai-agent caller in the touched set passes the App ID and key', () => {
    for (const file of ['issue-backlog-sweep.yml', 'cc-ci-fix.yml', 'cc-release-notes.yml']) {
      const workflow = load(file);
      const agent = Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .find((s) => s.uses === './.ai-workflows/.github/actions/run-ai-agent');
      expect(agent.with.claude_bot_app_id).toBe('${{ vars.GH_APP_CLAUDE_BOT_ID }}');
      expect(agent.with.claude_bot_private_key).toBe('${{ secrets.GH_APP_CLAUDE_BOT_PRIVATE_KEY }}');
    }
  });

  it('release notes end neutral on an unavailable agent, and only the deadline is reported there', () => {
    const script = readFileSync(
      join('.github', 'scripts', 'release-notes', 'agent-unavailable.sh'),
      'utf8',
    );
    expect(script).toContain('report "$JOB_NAME" deadline-exceeded');
    expect(script).not.toMatch(/report "\$JOB_NAME" "\$GATEWAY_CLASS"/);
  });
});
