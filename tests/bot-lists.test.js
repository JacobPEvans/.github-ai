const { expect, test } = require('bun:test');
const { readFileSync } = require('fs');
const { join } = require('path');
const { automationBots, dependencyBots, RELEASE_BOT, noModelBots } = require('../.github/scripts/shared/constants.js');

// Workflow conditions and input defaults cannot import shared/constants.js, so
// they repeat bot logins; these tests keep every copy equal to the constants.
const workflow = (name) => Bun.YAML.parse(readFileSync(join('.github', 'workflows', name), 'utf8'));
const logins = (expression) => [...String(expression).matchAll(/'([^']+\[bot\])'/g)].map(([, login]) => login).sort();

test('AI Review job conditions name exactly the no-model bots', () => {
  const jobs = workflow('ai-review.yml').jobs;
  expect(logins(jobs['dependency-bot'].if)).toEqual([...noModelBots].sort());
  expect(logins(jobs['pr-agent'].if)).toEqual([...noModelBots].sort());
});

test('issue-linker skips exactly the automation bots', () => {
  const linker = Object.values(workflow('issue-linker.yml').jobs).map((job) => job.if).join(' ');
  expect(logins(linker)).toEqual([...automationBots].sort());
});

test('workflow input defaults match the shared bot constants', () => {
  const releaseInputs = workflow('cc-release-notes.yml').on.workflow_call.inputs;
  const depInputs = workflow('cc-dep-review.yml').on.workflow_call.inputs;
  expect(Object.values(releaseInputs).map((input) => input.default)).toContain(RELEASE_BOT);
  for (const input of Object.values(depInputs)) {
    if (String(input.default).endsWith('[bot]')) expect(dependencyBots).toContain(input.default);
  }
});
