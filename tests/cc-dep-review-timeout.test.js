const { expect, test } = require('bun:test');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const workflow = Bun.YAML.parse(readFileSync('.github/workflows/cc-dep-review.yml', 'utf8'));
const dogfoodWorkflow = Bun.YAML.parse(readFileSync('.github/workflows/dogfood-dep-review.yml', 'utf8'));
const review = workflow.jobs.review;
const agent = review.steps.find((step) => step.name === 'Run AI agent');
const step = (name) => review.steps.find((candidate) => candidate.name === name);
const classify = step('Classify agent deadline');

function classifyDeadline({ subtype, gatewayClass = '', handoff = false, secondsAgo = 0, executionFilePresent = true }) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-dep-review-deadline-'));
  const executionFile = join(directory, 'claude-execution-output.json');
  const outputFile = join(directory, 'github-output');

  try {
    if (executionFilePresent) {
      writeFileSync(executionFile, JSON.stringify([
        { type: 'result', subtype: 'error_during_execution' },
        { type: 'assistant', subtype: 'text' },
        { type: 'result', subtype },
        { type: 'system', subtype: 'complete' },
      ]));
    }
    if (handoff) writeFileSync(join(directory, '.claude-dep-review.md'), 'handoff');
    writeFileSync(outputFile, '');

    const result = Bun.spawnSync(['bash', '-e', '-o', 'pipefail', '-c', classify.run], {
      cwd: directory,
      env: {
        ...process.env,
        STARTED: String(Math.floor(Date.now() / 1000) - secondsAgo),
        GATEWAY_CLASS: gatewayClass,
        EXECUTION_FILE: executionFilePresent ? executionFile : join(directory, 'missing.json'),
        GITHUB_OUTPUT: outputFile,
      },
    });
    expect(result.exitCode).toBe(0);

    return Object.fromEntries(readFileSync(outputFile, 'utf8').trim().split('\n').map((line) => line.split('=')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('dependency reviews use the cheap capability for opted-in non-semver updates', () => {
  expect(agent.with.claude_model).toContain("contains(fromJSON('[\"digest\",\"pin\",\"pinDigest\",\"lockFileMaintenance\"]')");
  expect(agent.with.claude_model).toContain('vars.GH_ACTION_AI_MODEL_CHEAP');
  expect(agent.with.claude_model).toContain("(github.event.repository.private && (vars.GH_ACTION_AI_MODEL_REVIEW || vars.GH_ACTION_AI_MODEL_CODE || vars.GH_ACTION_AI_MODEL) || 'review-oss')");
});

test('dependency review agent turn and output budgets are bounded', () => {
  expect(agent.with.claude_args).toBe('--max-turns 8');
  expect(review.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('4096');
});

test('the five-minute job retains its bound and the agent has a three-minute step deadline', () => {
  expect(review['timeout-minutes']).toBe("${{ github.event_name == 'pull_request' && 5 || 30 }}");
  expect(agent.id).toBe('agent');
  expect(agent['timeout-minutes']).toBe(3);
  expect(agent['continue-on-error']).toBe(true);
});

test('deadline reports use the neutral check-run path', () => {
  const mint = step('Mint the check-run token for the agent deadline');
  const report = step('Report agent deadline');
  const fail = step('Fail on non-deadline agent errors');

  expect(classify.if).toContain("steps.agent.outcome == 'failure'");
  expect(classify.run).toContain('[ -f .claude-dep-review.md ]');
  expect(classify.run).toContain(' -ge 180 ');
  expect(classify.env.GATEWAY_CLASS).toBe('${{ steps.agent.outputs.gateway_class }}');
  expect(classify.env.EXECUTION_FILE).toBe('${{ steps.agent.outputs.execution_file }}');
  expect(classify.run).toContain('[ -r "$EXECUTION_FILE" ]');
  expect(classify.run).toContain("select(.type == \"result\")][-1].subtype");
  expect(mint.if).toContain("steps.deadline.outputs.time_bound == 'true'");
  expect(mint.uses).toBe('./.ai-workflows/.github/actions/run-ai-agent/mint-check-token');
  expect(mint['continue-on-error']).toBe(true);
  expect(mint.with.client_id).toBe('${{ vars.GH_APP_CLAUDE_BOT_ID }}');
  expect(mint.with.private_key).toBe('${{ secrets.GH_APP_CLAUDE_BOT_PRIVATE_KEY }}');
  expect(report.env.CONCLUSION).toBe('neutral');
  expect(report.env.CHECK_HEAD_SHA).toBe('${{ github.event.pull_request.head.sha }}');
  expect(report.env.CHECK_SUMMARY).toBe('${{ steps.deadline.outputs.check_summary }}');
  expect(report.env.DEADLINE_CLASS).toBe('${{ steps.deadline.outputs.deadline_class }}');
  expect(report.env.NTFY_BASE_URL).toBeUndefined();
  expect(report.env.RUN_URL).toBeUndefined();
  expect(report.run).toContain('gateway-failure.sh report "Review dependency update" "$DEADLINE_CLASS"');
  expect(agent.with.ntfy_base_url).toBe('${{ secrets.NTFY_BASE_URL }}');
  expect(fail.if).toContain("steps.deadline.outputs.time_bound != 'true'");
});

test('the max-turns subtype reports a neutral check without an alert', () => {
  const deadline = classifyDeadline({ subtype: 'error_max_turns' });
  const report = step('Report agent deadline');

  expect(deadline).toEqual({
    time_bound: 'true',
    deadline_class: 'agent-max-turns',
    check_summary: 'bound reached (max turns): no review produced',
  });
  expect(report.env.CONCLUSION).toBe('neutral');
  expect(report.env.NTFY_BASE_URL).toBeUndefined();
});

test('the three-minute time bound retains its neutral summary and reason class', () => {
  const deadline = classifyDeadline({ subtype: 'error_during_execution', secondsAgo: 180 });

  expect(deadline).toEqual({
    time_bound: 'true',
    deadline_class: 'agent-time-bound',
    check_summary: 'time-bound: no review produced',
  });
});

test('gateway failures, handoffs, and short failures with other subtypes keep the failure path', () => {
  expect(classifyDeadline({ subtype: 'error_max_turns', gatewayClass: 'router-unavailable', secondsAgo: 180 })).toEqual({ time_bound: 'false' });
  expect(classifyDeadline({ subtype: 'error_max_turns', handoff: true, secondsAgo: 180 })).toEqual({ time_bound: 'false' });
  expect(classifyDeadline({ subtype: 'error_during_execution' })).toEqual({ time_bound: 'false' });
  expect(classifyDeadline({ subtype: 'error_max_turns', executionFilePresent: false })).toEqual({ time_bound: 'false' });
  expect(step('Fail on non-deadline agent errors').if).toContain("steps.deadline.outputs.time_bound != 'true'");
});

test('gateway responses cannot upload or publish a handoff', () => {
  expect(review.outputs.handoff).toBe("${{ steps.agent.outcome == 'success' && steps.agent.outputs.gateway_class == '' && steps.upload.outcome == 'success' }}");
  expect(step('Upload review handoff').if).toBe("steps.agent.outcome == 'success' && steps.agent.outputs.gateway_class == ''");
  expect(workflow.jobs.publish.if).toBe("needs.review.outputs.handoff == 'true'");
});

test('the dogfood caller passes both deadline alert secrets', () => {
  expect(dogfoodWorkflow.jobs.review.secrets.NTFY_BASE_URL).toBe('${{ secrets.NTFY_BASE_URL }}');
  expect(dogfoodWorkflow.jobs.review.secrets.GH_APP_CLAUDE_BOT_PRIVATE_KEY).toBe('${{ secrets.GH_APP_CLAUDE_BOT_PRIVATE_KEY }}');
});

test('run-ai-agent and dependency review share the check-token mint action', () => {
  const runAiAgentText = readFileSync('.github/actions/run-ai-agent/action.yml', 'utf8');
  const runAiAgent = Bun.YAML.parse(runAiAgentText);
  const runAiMint = runAiAgent.runs.steps.find((candidate) => candidate.name === 'Mint the check-run token');
  const report = runAiAgent.runs.steps.find((candidate) => candidate.name === 'Report gateway unavailability');
  const workflowText = readFileSync('.github/workflows/cc-dep-review.yml', 'utf8');
  const mintActionPath = '.github/actions/run-ai-agent/mint-check-token/action.yml';
  const mintAction = Bun.YAML.parse(readFileSync(mintActionPath, 'utf8'));
  const mintActionText = readFileSync(mintActionPath, 'utf8');

  expect(runAiMint.id).toBe('check-token');
  expect(runAiMint.if).toBe("always() && steps.claude.outcome == 'failure' && steps.report.outputs.gateway_class != ''");
  expect(runAiMint['continue-on-error']).toBe(true);
  expect(runAiMint.uses).toBe('./.ai-workflows/.github/actions/run-ai-agent/mint-check-token');
  expect(runAiMint.with.client_id).toBe('${{ inputs.claude_bot_app_id }}');
  expect(runAiMint.with.private_key).toBe('${{ inputs.claude_bot_private_key }}');
  expect(report.env.GITHUB_TOKEN).toBe('${{ steps.check-token.outputs.token }}');
  expect(workflowText).not.toContain('actions/create-github-app-token');
  expect(runAiAgentText).not.toContain('actions/create-github-app-token');
  expect(Object.keys(mintAction.inputs).sort()).toEqual(['client_id', 'private_key']);
  expect(mintAction.outputs.token.value).toBe('${{ steps.mint.outputs.token }}');
  expect(mintAction.runs.steps[0].uses).toBe('actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510');
  expect(mintAction.runs.steps[0].with['permission-checks']).toBe('write');
});
