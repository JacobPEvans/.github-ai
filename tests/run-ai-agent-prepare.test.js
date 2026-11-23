const { describe, it, expect } = require('bun:test');
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const prepareScript = join(import.meta.dir, '../.github/actions/run-ai-agent/prepare.sh');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function runValidate(sudoExitStatus, overrides = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'run-ai-agent-prepare-'));
  const binDir = join(tempDir, 'bin');
  const outputPath = join(tempDir, 'github-output');
  mkdirSync(binDir);
  const sudoStub = join(binDir, 'sudo');
  writeFileSync(sudoStub, `#!/bin/sh\nexit ${sudoExitStatus}\n`);
  chmodSync(sudoStub, 0o755);

  try {
    const result = spawnSync('bash', [prepareScript, 'validate'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT: 'codex',
        PERMISSION_PROFILE: 'read-only',
        BASE_URL: 'https://router.example.invalid/v1',
        API_KEY: 'dummy-api-key',
        CLAUDE_ARGS: '',
        ALLOWED_TOOLS: '',
        CLAUDE_MODEL: '',
        GITHUB_OUTPUT: outputPath,
        PATH: `${binDir}:${process.env.PATH}`,
        ...overrides,
      },
    });
    return { ...result, output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '' };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('run-ai-agent prepare validation', () => {
  (isRoot ? it.skip : it)('selects Claude and warns when non-root Codex cannot use passwordless sudo', () => {
    const result = runValidate(1);

    expect(result.status).toBe(0);
    expect(result.output).toContain('effective-agent=claude');
    expect(result.stdout).toContain('::warning::Codex needs passwordless sudo on this runner; Claude will run instead');
  });

  it('selects OpenHands with no fallback when a model is given', () => {
    const result = runValidate(1, { AGENT: 'openhands', OPENHANDS_MODEL: 'medium' });

    expect(result.status).toBe(0);
    expect(result.output).toContain('effective-agent=openhands');
  });

  it('gives every agent the local medium role when no model is set, and rejects an unknown agent', () => {
    const openhands = runValidate(0, { AGENT: 'openhands', OPENHANDS_MODEL: '' });
    expect(openhands.status).toBe(0);
    expect(openhands.output).toContain('openhands-model=medium\n');
    expect(openhands.output).toContain('codex-model=medium\n');
    expect(openhands.output).toContain('claude-args=--model medium\n');

    const role = runValidate(0, { AGENT: 'openhands', OPENHANDS_MODEL: '', CLAUDE_MODEL: 'large' });
    expect(role.output).toContain('openhands-model=large\n');
    expect(role.output).toContain('codex-model=large\n');
    expect(runValidate(0, { AGENT: 'openhands', OPENHANDS_MODEL: 'small' }).output).toContain('openhands-model=small\n');
    expect(runValidate(0, { CODEX_MODEL: 'review' }).output).toContain('codex-model=review\n');

    const unknown = runValidate(0, { AGENT: 'other' });
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toContain('agent must be claude, codex or openhands');
  });

  it('wires the OpenHands step by agent, by SHA and through env only', () => {
    const actionDir = join(import.meta.dir, '../.github/actions/run-ai-agent');
    const action = readFileSync(join(actionDir, 'action.yml'), 'utf8');
    const openhands = readFileSync(join(actionDir, 'openhands/action.yml'), 'utf8');
    const ciFix = readFileSync(join(import.meta.dir, '../.github/workflows/cc-ci-fix.yml'), 'utf8');

    expect(action).toContain("if: steps.prepare.outputs.effective-agent == 'openhands'\n      uses: ./.ai-workflows/.github/actions/run-ai-agent/openhands");
    expect(action).toContain("if: steps.prepare.outputs.effective-agent == 'codex'");
    expect(openhands).toMatch(/uses: actions\/setup-python@[0-9a-f]{40} # v\d/);
    for (const block of openhands.split(/\n\s+run: \|\n/).slice(1)) {
      expect(block.split(/\n    - name:/)[0]).not.toContain('${{');
    }
    expect(ciFix).toContain("if: inputs.agent != '' && inputs.agent != 'claude' && inputs.local_only");
    expect(ciFix).toContain("agent: ${{ inputs.agent || (inputs.local_only && 'claude' || vars.GH_ACTION_AI_AGENT || 'openhands') }}");
    expect(action).toContain('model: ${{ steps.prepare.outputs.openhands-model }}');
    expect(action).toContain('model: ${{ steps.prepare.outputs.codex-model }}');
    const steps = Bun.YAML.parse(action).runs.steps;
    for (const name of ['Run OpenHands', 'Run Codex']) {
      expect(steps.find((s) => s.name === name).env.GH_TOKEN).toBe('${{ github.token }}');
    }
  });

  it('defaults to OpenHands when the caller and the org variable are silent', () => {
    const workflows = join(import.meta.dir, '../.github/workflows');
    const action = Bun.YAML.parse(readFileSync(join(import.meta.dir, '../.github/actions/run-ai-agent/action.yml'), 'utf8'));
    expect(action.inputs.agent.default).toBe('openhands');
    for (const name of ['cc-ci-fix', 'cc-ci-fix-oidc', 'cc-issue-resolver', 'cc-pr-review-responder']) {
      const text = readFileSync(join(workflows, `${name}.yml`), 'utf8');
      expect(text).toContain("vars.GH_ACTION_AI_AGENT || 'openhands'");
      expect(text).not.toContain("vars.GH_ACTION_AI_AGENT || 'claude'");
    }
  });

  it('stops OpenHands at its time limit with a message, and passes its own exit code through', () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const action = Bun.YAML.parse(readFileSync(join(import.meta.dir, '../.github/actions/run-ai-agent/openhands/action.yml'), 'utf8'));
    const step = action.runs.steps.find((s) => s.name === 'Run OpenHands');
    expect(action.inputs.time_limit_minutes.default).toBe('25');
    expect(step.env.TIME_LIMIT_MINUTES).toBe('${{ inputs.time_limit_minutes }}');
    const run = (python, keep = '') => {
      const dir = mkdtempSync(join(tmpdir(), 'openhands-limit-'));
      try {
        writeFileSync(join(dir, 'python'), `#!/bin/sh\n${python}\n`);
        chmodSync(join(dir, 'python'), 0o755);
        return spawnSync('/bin/bash', ['-c', step.run], {
          encoding: 'utf8',
          env: { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, PROMPT: 'p', MODEL: 'm', TIME_LIMIT_MINUTES: '0.02', KEEP_EDITS: keep },
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const stopped = run('sleep 5');
    expect(stopped.status).toBe(124);
    expect(stopped.stdout).toContain('OpenHands stopped at its 0.02-minute limit');
    const kept = run('sleep 5', 'true');
    expect(kept.status).toBe(0);
    expect(kept.stdout).toContain('its edits so far are kept');
    expect(run('exit 3', 'true').status).toBe(3);
    expect(run('exit 0').status).toBe(0);
    const failed = run('exit 3');
    expect(failed.status).toBe(3);
    expect(failed.stdout).not.toContain('stopped at');
  });

  it('keeps Codex selected when passwordless sudo succeeds', () => {
    const result = runValidate(0);

    expect(result.status).toBe(0);
    expect(result.output).toContain('effective-agent=codex');
  });
});

describe('agent job token scope', () => {
  // The agent steps receive the job token, so every job that runs the agent action must be read-only.
  it('grants no write scope except id-token to any job that runs the agent action', () => {
    const dir = join(import.meta.dir, '../.github/workflows');
    const jobs = [];
    for (const file of readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))) {
      const workflow = Bun.YAML.parse(readFileSync(join(dir, file), 'utf8'));
      for (const [name, job] of Object.entries(workflow.jobs || {})) {
        const runsAgent = (job.steps || []).some((step) => /\.github\/actions\/run-ai-agent$/.test(step.uses || ''));
        if (runsAgent) jobs.push({ where: `${file}:${name}`, permissions: job.permissions });
      }
    }

    expect(jobs.length).toBeGreaterThanOrEqual(17);
    for (const { where, permissions } of jobs) {
      // A job-level block is required, so a workflow-level or default grant never reaches the agent.
      expect([where, typeof permissions]).toEqual([where, 'object']);
      const writes = Object.entries(permissions).filter(([scope, level]) => level === 'write' && scope !== 'id-token');
      expect([where, writes]).toEqual([where, []]);
    }
  });

  // A job that runs an agent holds no App key and no store write identity; publishers and check reporters run in their own jobs.
  it('keeps App keys, check-token mints and store write roles out of every job that runs the agent action', () => {
    const forbidden = /GH_APP_CLAUDE_BOT_PRIVATE_KEY|claude_bot_private_key|mint-check-token|create-github-app-token|github\/token|\b(?:openhands-write|claude-write|gate-checks|openhands-workflows|pr-reconcile)/;
    const dir = join(import.meta.dir, '../.github/workflows');
    const offenders = [];
    for (const file of readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))) {
      const workflow = Bun.YAML.parse(readFileSync(join(dir, file), 'utf8'));
      for (const [name, job] of Object.entries(workflow.jobs || {})) {
        const runsAgent = (job.steps || []).some((step) => /\.github\/actions\/run-ai-agent$/.test(step.uses || ''));
        if (runsAgent && forbidden.test(JSON.stringify(job))) offenders.push(`${file}:${name}`);
      }
    }
    const action = readFileSync(join(import.meta.dir, '../.github/actions/run-ai-agent/action.yml'), 'utf8');
    if (forbidden.test(action)) offenders.push('actions/run-ai-agent/action.yml');
    expect(offenders).toEqual([]);
  });

  it('runs the OpenHands sub-action only from the agent action', () => {
    const roots = ['../.github/workflows', '../.github/actions'].map((path) => join(import.meta.dir, path));
    const users = [];
    const walk = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.ya?ml$/.test(entry.name) && readFileSync(full, 'utf8').includes('actions/run-ai-agent/openhands')) users.push(full);
      }
    };
    roots.forEach(walk);
    expect(users.map((path) => path.split('/.github/')[1])).toEqual(['actions/run-ai-agent/action.yml']);
  });
});
