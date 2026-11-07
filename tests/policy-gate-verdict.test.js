const { expect, test } = require('bun:test');
const { mkdtempSync, rmSync, writeFileSync, readFileSync } = require('fs');
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
    const env = { ...process.env, RUBRIC: rubric, RESPONSE_FILE: file };
    if (rubric === 'leak') {
      const diff = join(dir, 'diff.patch');
      writeFileSync(diff, '');
      env.DIFF_FILE = diff;
    }
    return Bun.spawnSync(['bash', script], {
      env,
    }).exitCode;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function leakResult(response, patch) {
  const dir = mkdtempSync(join(tmpdir(), 'policy-leak-grounding-'));
  try {
    const file = join(dir, 'response.json');
    const diff = join(dir, 'diff.patch');
    const summary = join(dir, 'summary.md');
    writeFileSync(file, response);
    writeFileSync(diff, patch);
    writeFileSync(summary, '');

    const validation = Bun.spawnSync(['bash', script], {
      env: {
        ...process.env,
        RUBRIC: 'leak',
        RESPONSE_FILE: file,
        DIFF_FILE: diff,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    let renderedExit = null;
    if (validation.exitCode === 0) {
      Bun.spawnSync(['bash', join(process.cwd(), '.github', 'scripts', 'policy-gate', 'render.sh')], {
        cwd: dir,
        env: { ...process.env, MODEL: 'light', RESPONSE_FILE: file },
      });
      renderedExit = readFileSync(join(dir, 'policy-gate.exit'), 'utf8').trim();
    }

    return {
      validationExit: validation.exitCode,
      validationStderr: validation.stderr.toString(),
      response: readFileSync(file, 'utf8'),
      summary: readFileSync(summary, 'utf8'),
      renderedExit,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function patch(lines, hunk = '@@ -0,0 +1 @@') {
  return [
    'diff --git a/config.yml b/config.yml',
    'index 1111111..2222222 100644',
    '--- a/config.yml',
    '+++ b/config.yml',
    hunk,
    ...lines,
    '',
  ].join('\n');
}

const makeFinding = (check, result = 'pass', overrides = {}) => ({
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
const verdictWith = (checks) => JSON.stringify({ summary: 'ok', findings: checks.map((c) => makeFinding(c)) });

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
  const verdict = {
    summary: 'two',
    findings: [
      makeFinding('credential', 'fail', { file: 'config.yml', line: 1 }),
      makeFinding('credential', 'fail', { file: 'config.yml', line: 2 }),
    ],
  };
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
  const checks = POLICY.map((c, i) => makeFinding(c, i === 0 ? 'maybe' : 'pass'));
  expect(exitCodeFor('policy', JSON.stringify({ summary: 'ok', findings: checks }))).toBe(1);
});

test('rejects a line that is not a number', () => {
  const checks = POLICY.map((c, i) => makeFinding(c, 'pass', i === 0 ? { line: '12' } : {}));
  expect(exitCodeFor('policy', JSON.stringify({ summary: 'ok', findings: checks }))).toBe(1);
});

test('rejects keys the verdict does not define', () => {
  const verdict = { summary: 'ok', findings: POLICY.map((c) => makeFinding(c)), command: 'merge' };
  expect(exitCodeFor('policy', JSON.stringify(verdict))).toBe(1);
});

test('rejects a response that is not an object', () => {
  expect(exitCodeFor('policy', '["dry"]')).toBe(1);
});

test('rejects an unknown rubric', () => {
  expect(exitCodeFor('bogus', verdictWith(POLICY))).toBe(2);
});

test('drops a leak finding when the added line has no candidate token', () => {
  const finding = {
    ...makeFinding('private_host_or_ip', 'fail', { file: 'config.yml', line: 1, detail: 'Exposes a private host.' }),
  };
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+message: ordinary text']),
  );

  expect(result.validationStderr).toBe('');
  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([]);
  expect(result.renderedExit).toBe('0');
  expect(result.summary).toBe('UNGROUNDED | config.yml:1 | no_candidate\n');
  expect(result.summary).not.toContain('ordinary text');
});

test('drops a leak finding that cites an unchanged line', () => {
  const finding = {
    ...makeFinding('private_host_or_ip', 'fail', {
      file: 'config.yml', line: 1, detail: 'Exposes "vault.private.lan".',
    }),
  };
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch([
      ' host: vault.private.lan',
      '-mode: old',
      '+mode: new',
    ], '@@ -1,2 +1,2 @@'),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([]);
  expect(result.renderedExit).toBe('0');
  expect(result.summary).toBe('UNGROUNDED | config.yml:1 | line_not_added\n');
  expect(result.summary).not.toContain('vault.private.lan');
});

test.each(['https://example.com/private', 'https://example.test/private'])(
  'drops a leak finding for an exempt URL: %s',
  (url) => {
    const finding = {
      ...makeFinding('private_host_or_ip', 'fail', {
        file: 'config.yml', line: 1, detail: `Uses "${url}".`,
      }),
    };
    const result = leakResult(
      JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
      patch([`+url: ${url}`]),
    );

    expect(result.validationExit).toBe(0);
    expect(JSON.parse(result.response).findings).toEqual([]);
    expect(result.renderedExit).toBe('0');
    expect(result.summary).toBe('UNGROUNDED | config.yml:1 | quoted_text_has_no_candidate\n');
    expect(result.summary).not.toContain(url);
  },
);

test('keeps a leak finding for a private host on an added line', () => {
  const finding = {
    ...makeFinding('private_host_or_ip', 'fail', {
      file: 'config.yml', line: 1, detail: 'Exposes a private host.',
    }),
  };
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+host: vault.private.lan']),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([finding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('');
});

test('keeps a leak finding for an RFC1918 address on an added line', () => {
  const finding = {
    ...makeFinding('private_host_or_ip', 'fail', {
      file: 'config.yml', line: 1, detail: "Exposes '192.168.20.10'.",
    }),
  };
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+endpoint: 192.168.20.10']),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([finding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('');
});

test('keeps findings grounded by URLs, email addresses, and secret-like tokens', () => {
  const cases = [
    ['private_host_or_ip', 'url: https://service.internal/api'],
    ['incident_detail', 'contact: ops@private.internal'],
    ['credential', 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  ];

  for (const [check, line] of cases) {
    const finding = makeFinding(check, 'fail', {
      file: 'config.yml', line: 1, detail: 'Contains a candidate token.',
    });
    const result = leakResult(
      JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
      patch([`+${line}`]),
    );

    expect(result.validationExit).toBe(0);
    expect(JSON.parse(result.response).findings).toEqual([finding]);
    expect(result.renderedExit).toBe('1');
    expect(result.summary).toBe('');
  }
});

test('malformed leak verdict still fails closed', () => {
  const result = leakResult('{"summary":', patch(['+host: vault.private.lan']));

  expect(result.validationExit).not.toBe(0);
  expect(result.renderedExit).toBeNull();
});

test('leak findings without a file and positive line fail closed', () => {
  const verdict = {
    summary: 'One suspected leak.',
    findings: [makeFinding('private_host_or_ip', 'fail', { file: '', line: 0 })],
  };
  const result = leakResult(JSON.stringify(verdict), patch(['+host: vault.private.lan']));

  expect(result.validationExit).not.toBe(0);
  expect(result.renderedExit).toBeNull();
});
