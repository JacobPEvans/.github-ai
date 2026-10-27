const { expect, test } = require('bun:test');
const { assessProposal, matchesGlob } = require('../.github/scripts/learning-gate/learning-gate.js');

const HEAD = 'a'.repeat(40);
const BASE = {
  labels: ['learning-proposal', 'dataset:quality'],
  files: [{ filename: 'prompts/nested/agent.md', status: 'modified' }],
  allowedPaths: 'prompts/**,skills/**',
  initialHeadSha: HEAD,
  currentHeadSha: HEAD,
};

test('allowlisted prompt paths pass, including nested ** matches', () => {
  expect(matchesGlob('prompts/nested/agent.md', 'prompts/**')).toBe(true);
  expect(assessProposal(BASE)).toMatchObject({
    dataset: 'quality',
    eligible: true,
    reasons: [],
  });
});

test('rules, .github, and security paths require human review', () => {
  for (const filename of [
    'rules/policy.md',
    '.github/workflows/check.yml',
    'skills/security/guide.md',
    'security/prompt.md',
  ]) {
    const result = assessProposal({
      ...BASE,
      files: [{ filename, status: 'modified' }],
      allowedPaths: '**',
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('protected paths require human review');
  }
});

test('missing dataset labels require human review', () => {
  const result = assessProposal({ ...BASE, labels: ['learning-proposal'] });
  expect(result.eligible).toBe(false);
  expect(result.reasons.join(' ')).toContain('exactly one dataset:<name>');
});

test('duplicate dataset labels require human review', () => {
  const result = assessProposal({
    ...BASE,
    labels: ['learning-proposal', 'dataset:quality', 'dataset:quality'],
  });
  expect(result.eligible).toBe(false);
  expect(result.reasons.join(' ')).toContain('exactly one dataset:<name>');
});

test('added and deleted files require human review', () => {
  for (const status of ['added', 'removed']) {
    const result = assessProposal({
      ...BASE,
      files: [{ filename: 'prompts/agent.md', status }],
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('added, deleted, or renamed files require review');
  }
});

test('a changed head sha requires human review', () => {
  const result = assessProposal({
    ...BASE,
    currentHeadSha: 'b'.repeat(40),
  });
  expect(result.eligible).toBe(false);
  expect(result.reasons).toContain('proposal head changed during discovery');
});
