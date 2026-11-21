const { describe, it, expect } = require('bun:test');
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
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
    const run = (python) => {
      const dir = mkdtempSync(join(tmpdir(), 'openhands-limit-'));
      try {
        writeFileSync(join(dir, 'python'), `#!/bin/sh\n${python}\n`);
        chmodSync(join(dir, 'python'), 0o755);
        return spawnSync('/bin/bash', ['-c', step.run], {
          encoding: 'utf8',
          env: { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, PROMPT: 'p', MODEL: 'm', TIME_LIMIT_MINUTES: '0.02' },
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const stopped = run('sleep 5');
    expect(stopped.status).toBe(124);
    expect(stopped.stdout).toContain('OpenHands stopped at its 0.02-minute limit');
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
