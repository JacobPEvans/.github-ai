const { expect, test } = require('bun:test');
const { readFileSync } = require('node:fs');

const workflow = Bun.YAML.parse(readFileSync('.github/workflows/cc-dep-review.yml', 'utf8'));
const review = workflow.jobs.review;
const agent = review.steps.find((step) => step.name === 'Run AI agent');

test('dependency reviews use the cheap capability for opted-in non-semver updates', () => {
  expect(agent.with.claude_model).toContain("contains(fromJSON('[\"digest\",\"pin\",\"pinDigest\",\"lockFileMaintenance\"]')");
  expect(agent.with.claude_model).toContain('vars.GH_ACTION_AI_MODEL_CHEAP');
  expect(agent.with.claude_model).toContain("(github.event.repository.private && (vars.GH_ACTION_AI_MODEL_REVIEW || vars.GH_ACTION_AI_MODEL_CODE || vars.GH_ACTION_AI_MODEL) || 'review-oss')");
});
