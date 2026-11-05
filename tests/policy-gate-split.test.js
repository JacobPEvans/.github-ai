const { expect, test } = require('bun:test');
const { readFileSync } = require('fs');
const { join } = require('path');

// policy-gate reads the pull request text and diff, which are untrusted. The router call
// happens in the review job, which holds no App key. Only the gate job, which validates the
// verdict and posts it, holds the App key and the App id.
const file = join('.github', 'workflows', 'policy-gate.yml');
const workflow = Bun.YAML.parse(readFileSync(file, 'utf8'));
const APP_REFS = ['GH_APP_CLAUDE_BOT_PRIVATE_KEY', 'GH_APP_CLAUDE_BOT_ID'];
const ROUTER_REFS = ['LLM_ROUTER_API_KEY', 'actions/ai-inference'];

const mentions = (node, refs) => {
  const text = JSON.stringify(node);
  return refs.some((ref) => text.includes(ref));
};

const holdersOf = (refs) =>
  Object.entries(workflow.jobs)
    .filter(([, job]) => mentions(job, refs))
    .map(([name]) => name)
    .sort();

test('the review job holds neither the App key nor the App id', () => {
  expect(mentions(workflow.jobs.review, APP_REFS)).toBe(false);
});

test('only the gate job references the App key or the App id', () => {
  expect(holdersOf(APP_REFS)).toEqual(['gate']);
});

test('only the review job calls the router', () => {
  expect(holdersOf(ROUTER_REFS)).toEqual(['review']);
});

test('the gate job keeps its name and runs after the review job', () => {
  expect(workflow.jobs.gate.name).toBe('Policy gate');
  expect(workflow.jobs.gate.needs).toEqual(['review']);
});

test('the review job hands its result to the gate job through an artifact', () => {
  const uploads = workflow.jobs.review.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
  const downloads = workflow.jobs.gate.steps.filter((step) => step.uses?.startsWith('actions/download-artifact@'));
  expect(uploads).toHaveLength(1);
  expect(downloads).toHaveLength(1);
  expect(downloads[0].with.name).toBe(uploads[0].with.name);
});
