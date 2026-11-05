const { expect, test } = require('bun:test');
const { mkdtempSync, rmSync, writeFileSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

// The gate job re-validates the review job's verdict before anything renders it. The validator
// accepts only the check names the rubric defines, pass or fail results, and the field types
// that render.sh reads.
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

const policyChecks = ['dry', 'native_first', 'disclosure', 'missing_test', 'token_budget'];
const policyVerdict = { summary: 'No issues found.', findings: policyChecks.map((c) => finding(c)) };

test('accepts a well-formed policy verdict', () => {
  expect(exitCodeFor('policy', JSON.stringify(policyVerdict))).toBe(0);
});

test('accepts a security verdict that uses the security checks', () => {
  const verdict = { summary: 'ok', findings: [finding('auth'), finding('injection', 'fail', { file: 'a.yml', line: 3, detail: 'x' })] };
  expect(exitCodeFor('security', JSON.stringify(verdict))).toBe(0);
});

// A rejected verdict exits 1 (jq -e on false). Exit 127 would mean the script never ran.
test('rejects a check that the rubric does not define', () => {
  const verdict = { summary: 'ok', findings: [finding('auth')] };
  expect(exitCodeFor('policy', JSON.stringify(verdict))).toBe(1);
});

test('rejects a result other than pass or fail', () => {
  const verdict = { summary: 'ok', findings: [finding('dry', 'maybe')] };
  expect(exitCodeFor('policy', JSON.stringify(verdict))).toBe(1);
});

test('rejects a line that is not a number', () => {
  const verdict = { summary: 'ok', findings: [finding('dry', 'fail', { line: '12' })] };
  expect(exitCodeFor('policy', JSON.stringify(verdict))).toBe(1);
});

test('rejects keys the verdict does not define', () => {
  const verdict = { ...policyVerdict, command: 'merge' };
  expect(exitCodeFor('policy', JSON.stringify(verdict))).toBe(1);
});

test('rejects a response that is not an object', () => {
  expect(exitCodeFor('policy', '["dry"]')).toBe(1);
});

test('rejects an unknown rubric', () => {
  expect(exitCodeFor('bogus', JSON.stringify(policyVerdict))).toBe(2);
});
