const { expect, test } = require('bun:test');
const { mkdtempSync, rmSync, writeFileSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

// The gate job re-validates the review job's verdict before anything renders it. The validator
// accepts a verdict only when it names the rubric's checks: exactly one finding per check for
// the fixed rubrics, and any number of findings from the leak rubric's own categories. Result
// values and field types must match what render.sh reads.
const script = join(process.cwd(), '.github', 'scripts', 'policy-gate', 'validate-verdict.sh');

function exitCodeFor(rubric, response) {
  const dir = mkdtempSync(join(tmpdir(), 'policy-verdict-'));
  try {
    const file = join(dir, 'response.json');
    writeFileSync(file, response);
    return Bun.spawnSync(['bash', script], {
      env: { ...process.env, RUBRIC: rubric, RESPONSE_FILE: file },
    }).exitCode;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const finding = (check, result = 'pass', overrides = {}) => ({
  check,
  result,
  file: '',
  line: 0,
  detail: '',
  ...overrides,
});

const POLICY = ['dry', 'native_first', 'disclosure', 'missing_test', 'token_budget'];
const SECURITY = ['auth', 'injection', 'permission_widening', 'unsafe_trigger', 'secret_handling'];
const SEMANTIC = ['claim_mismatch', 'omitted_behavior'];
const verdictWith = (checks) => JSON.stringify({ summary: 'ok', findings: checks.map((c) => finding(c)) });

// A rejected verdict exits 1 (jq -e on false). Exit 127 would mean the script never ran.
test('accepts a well-formed policy verdict', () => {
  expect(exitCodeFor('policy', verdictWith(POLICY))).toBe(0);
});

test('accepts a security verdict with exactly one finding per security check', () => {
  expect(exitCodeFor('security', verdictWith(SECURITY))).toBe(0);
});

test('accepts a semantic verdict with exactly one finding per semantic check', () => {
  expect(exitCodeFor('semantic', verdictWith(SEMANTIC))).toBe(0);
});

test('accepts a leak verdict with no findings, which is a clean review', () => {
  expect(exitCodeFor('leak', JSON.stringify({ summary: 'clean', findings: [] }))).toBe(0);
});

test('accepts a leak verdict with several findings in one category', () => {
  const verdict = { summary: 'two', findings: [finding('credential', 'fail'), finding('credential', 'fail')] };
  expect(exitCodeFor('leak', JSON.stringify(verdict))).toBe(0);
});

test('rejects a policy verdict with no findings, which would skip every check', () => {
  expect(exitCodeFor('policy', JSON.stringify({ summary: 'No issues', findings: [] }))).toBe(1);
});

test('rejects a policy verdict that omits a check', () => {
  expect(exitCodeFor('policy', verdictWith(POLICY.slice(0, 4)))).toBe(1);
});

test('rejects a policy verdict that repeats one check and omits another', () => {
  expect(exitCodeFor('policy', verdictWith(['dry', 'dry', 'native_first', 'disclosure', 'missing_test']))).toBe(1);
});

test('rejects a security verdict with fewer than five findings', () => {
  expect(exitCodeFor('security', verdictWith(['auth', 'injection']))).toBe(1);
});

test('rejects a semantic verdict with one finding', () => {
  expect(exitCodeFor('semantic', verdictWith(['claim_mismatch']))).toBe(1);
});

test('rejects a check that the rubric does not define', () => {
  expect(exitCodeFor('policy', verdictWith(['auth', ...POLICY.slice(1)]))).toBe(1);
});

test('rejects a result other than pass or fail', () => {
  const checks = POLICY.map((c, i) => finding(c, i === 0 ? 'maybe' : 'pass'));
  expect(exitCodeFor('policy', JSON.stringify({ summary: 'ok', findings: checks }))).toBe(1);
});

test('rejects a line that is not a number', () => {
  const checks = POLICY.map((c, i) => finding(c, 'pass', i === 0 ? { line: '12' } : {}));
  expect(exitCodeFor('policy', JSON.stringify({ summary: 'ok', findings: checks }))).toBe(1);
});

test('rejects keys the verdict does not define', () => {
  const verdict = { summary: 'ok', findings: POLICY.map((c) => finding(c)), command: 'merge' };
  expect(exitCodeFor('policy', JSON.stringify(verdict))).toBe(1);
});

test('rejects a response that is not an object', () => {
  expect(exitCodeFor('policy', '["dry"]')).toBe(1);
});

test('rejects an unknown rubric', () => {
  expect(exitCodeFor('bogus', verdictWith(POLICY))).toBe(2);
});
