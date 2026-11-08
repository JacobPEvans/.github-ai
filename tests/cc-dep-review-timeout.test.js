const { expect, test } = require('bun:test');
const { readFileSync } = require('node:fs');

const workflow = Bun.YAML.parse(readFileSync('.github/workflows/cc-dep-review.yml', 'utf8'));
const dogfoodWorkflow = Bun.YAML.parse(readFileSync('.github/workflows/dogfood-dep-review.yml', 'utf8'));
const review = workflow.jobs.review;
const agent = review.steps.find((step) => step.name === 'Run AI agent');
const step = (name) => review.steps.find((candidate) => candidate.name === name);

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

test('only a missing handoff after the agent deadline is reported neutral', () => {
  const classify = step('Classify agent deadline');
  const mint = step('Mint the check-run token for the agent deadline');
  const report = step('Report agent deadline');
  const fail = step('Fail on non-deadline agent errors');

  expect(classify.if).toContain("steps.agent.outcome == 'failure'");
  expect(classify.run).toContain('[ -f .claude-dep-review.md ]');
  expect(classify.run).toContain(' -lt 180 ');
  expect(classify.env.GATEWAY_CLASS).toBe('${{ steps.agent.outputs.gateway_class }}');
  expect(mint.if).toContain("steps.deadline.outputs.time_bound == 'true'");
  expect(mint.uses).toBe('./.ai-workflows/.github/actions/run-ai-agent/mint-check-token');
  expect(mint['continue-on-error']).toBe(true);
  expect(mint.with.client_id).toBe('${{ vars.GH_APP_CLAUDE_BOT_ID }}');
  expect(mint.with.private_key).toBe('${{ secrets.GH_APP_CLAUDE_BOT_PRIVATE_KEY }}');
  expect(report.env.CONCLUSION).toBe('neutral');
  expect(report.env.CHECK_HEAD_SHA).toBe('${{ github.event.pull_request.head.sha }}');
  expect(report.env.CHECK_SUMMARY).toBe('time-bound: no review produced');
  expect(report.env.NTFY_BASE_URL).toBeUndefined();
  expect(report.env.RUN_URL).toBeUndefined();
  expect(report.run).toContain('gateway-failure.sh report "Review dependency update" agent-time-bound');
  expect(agent.with.ntfy_base_url).toBe('${{ secrets.NTFY_BASE_URL }}');
  expect(fail.if).toContain("steps.deadline.outputs.time_bound != 'true'");
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
