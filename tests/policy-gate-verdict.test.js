const { expect, test } = require('bun:test');
const { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } = require('fs');
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

function patch(lines, hunk = '@@ -0,0 +1 @@', file = 'config.yml') {
  return [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
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

test('validates leak findings against the aggregate GitHub pull-request diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-leak-aggregate-diff-'));
  try {
    const bin = join(dir, 'bin');
    const response = join(dir, 'response.json');
    const diff = join(dir, 'diff.patch');
    const event = join(dir, 'event.json');
    const summary = join(dir, 'summary.md');
    const request = join(dir, 'curl-request.txt');
    const curl = join(bin, 'curl');
    const finding = makeFinding('private_host_or_ip', 'fail', {
      file: 'config.yml', line: 1, detail: 'Exposes a private host.',
    });
    writeFileSync(response, JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }));
    writeFileSync(diff, patch(['+host: vault.private.lan']));
    writeFileSync(event, JSON.stringify({
      pull_request: { number: 12, changed_files: 1, additions: 1, deletions: 0 },
    }));
    writeFileSync(summary, '');
    mkdirSync(bin);
    writeFileSync(curl, `#!/bin/sh
output=
request_url=
accept_header=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --header) accept_header="$2"; shift 2 ;;
    --write-out|--max-time|--max-filesize) shift 2 ;;
    --silent|--show-error|--fail) shift ;;
    *) request_url="$1"; shift ;;
  esac
done
printf '%s\\n%s\\n' "$request_url" "$accept_header" > "$CURL_REQUEST_FILE"
cat "$DIFF_FIXTURE" > "$output"
printf 200
`);
    chmodSync(curl, 0o755);

    const validation = Bun.spawnSync(['bash', script], {
      env: {
        ...process.env,
        RUBRIC: 'leak',
        RESPONSE_FILE: response,
        GITHUB_EVENT_PATH: event,
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_STEP_SUMMARY: summary,
        CURL_REQUEST_FILE: request,
        DIFF_FIXTURE: diff,
        PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
      },
    });

    expect(validation.exitCode).toBe(0);
    expect(readFileSync(request, 'utf8').trim().split('\n')).toEqual([
      'https://api.github.com/repos/owner/repo/pulls/12',
      'Accept: application/vnd.github.diff',
    ]);
    expect(JSON.parse(readFileSync(response, 'utf8')).findings).toEqual([finding]);
    expect(readFileSync(summary, 'utf8')).toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('drops a leak finding when its path is absent from the diff', () => {
  const finding = makeFinding('private_host_or_ip', 'fail', {
    file: 'missing.yml', line: 1, detail: '',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+host: vault.private.lan']),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([]);
  expect(result.renderedExit).toBe('0');
  expect(result.summary).toBe('UNGROUNDED | missing.yml:1 | path_not_in_diff\n');
  expect(result.summary).not.toContain('vault.private.lan');
});

test('keeps a credential finding for a short password on an added line', () => {
  const finding = makeFinding('credential', 'fail', {
    file: 'config.yml', line: 1, detail: '',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+password: pw']),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([finding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('');
});

test('keeps a credential finding for a URL with userinfo on an added line', () => {
  const finding = makeFinding('credential', 'fail', {
    file: 'config.yml', line: 1, detail: '',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+url: https://user:pw@example.com']),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([finding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('');
});

test('drops a leak finding that cites an unchanged line', () => {
  const finding = {
    ...makeFinding('private_host_or_ip', 'fail', {
      file: 'config.yml', line: 1, detail: 'Exposes a private host.',
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

test.each([
  'https://example.com/private',
  'https://example.test/private',
  'https://192.0.2.1/private',
  'https://[2001:db8::1]/private',
  '192.0.2.1',
  '198.51.100.42',
  '203.0.113.254',
  '2001:db8::1',
  '2001:db8::',
  '2001:0db8:0000:0000:0000:0000:0000:0001',
])(
  'drops a leak finding for a rubric documentation value: %s',
  (value) => {
    const finding = {
      ...makeFinding('private_host_or_ip', 'fail', {
        file: 'config.yml', line: 1, detail: '',
      }),
    };
    const result = leakResult(
      JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
      patch([`+value: ${value}`]),
    );

    expect(result.validationExit).toBe(0);
    expect(JSON.parse(result.response).findings).toEqual([]);
    expect(result.renderedExit).toBe('0');
    expect(result.summary).toBe('UNGROUNDED | config.yml:1 | no_candidate\n');
    expect(result.summary).not.toContain(value);
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

test('drops a private-host finding for example.com on an added line', () => {
  const finding = makeFinding('private_host_or_ip', 'fail', {
    file: 'config.yml', line: 1, detail: '',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+hostname: example.com']),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([]);
  expect(result.renderedExit).toBe('0');
  expect(result.summary).toBe('UNGROUNDED | config.yml:1 | no_candidate\n');
});

test('keeps a private-host finding for a token with letters and digits', () => {
  const finding = makeFinding('private_host_or_ip', 'fail', {
    file: 'config.yml', line: 1, detail: '',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+node: db-01']),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([finding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('');
});

test.each([
  'host: mercury',
  'host: "mercury"',
  "host: 'mercury'",
])('keeps a private-host finding for a bare word after a host-like key: %s', (line) => {
  const finding = makeFinding('private_host_or_ip', 'fail', {
    file: 'config.yml', line: 1, detail: '',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch([`+${line}`]),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([finding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('');
});

test('keeps a bare host after a quoted host-like key', () => {
  const finding = makeFinding('private_host_or_ip', 'fail', {
    file: 'config.yml', line: 1, detail: '',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+"host": "mercury"']),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([finding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('');
});

test('judges a host token independently beside an exempt URL', () => {
  const finding = makeFinding('private_host_or_ip', 'fail', {
    file: 'config.yml', line: 1, detail: '',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+db-01 https://example.com/db-01']),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([finding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('');
});

test.each([
  'url: https://service.internal/api',
  'contact: ops@private.internal',
  'address: fc00::1',
])('keeps a private-host finding for a URL, email, or IPv6 candidate: %s', (line) => {
  const finding = makeFinding('private_host_or_ip', 'fail', {
    file: 'config.yml', line: 1, detail: '',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch([`+${line}`]),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([finding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('');
});

test.each(['internal_topology', 'incident_detail'])(
  'keeps a %s finding on an added prose line',
  (check) => {
    const finding = makeFinding(check, 'fail', {
      file: 'config.yml', line: 1, detail: '',
    });
    const result = leakResult(
      JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
      patch(['+This is ordinary prose without a host or secret.']),
    );

    expect(result.validationExit).toBe(0);
    expect(JSON.parse(result.response).findings).toEqual([finding]);
    expect(result.renderedExit).toBe('1');
    expect(result.summary).toBe('');
  },
);

test('keeps an unknown leak check finding on an added prose line', () => {
  const finding = makeFinding('unknown_check', 'fail', {
    file: 'config.yml', line: 1, detail: '',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+This is ordinary prose without a host or secret.']),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([finding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('');
});

test('keeps a private-host finding when the added file path is C-quoted Unicode', () => {
  const finding = makeFinding('private_host_or_ip', 'fail', {
    file: 'café.yml', line: 1, detail: '',
  });
  const quotedUnicodePatch = [
    'diff --git "a/caf\\303\\251.yml" "b/caf\\303\\251.yml"',
    'index 1111111..2222222 100644',
    '--- "a/caf\\303\\251.yml"',
    '+++ "b/caf\\303\\251.yml"',
    '@@ -0,0 +1 @@',
    '+message: ordinary prose',
    '',
  ].join('\n');
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    quotedUnicodePatch,
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([finding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('');
});

test('does not exempt a URL with userinfo from private-host checks', () => {
  const finding = makeFinding('private_host_or_ip', 'fail', {
    file: 'config.yml', line: 1, detail: '',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+url: https://user:pw@example.com']),
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

test('keeps a leak finding for an RFC1918 address inside a URL on an added line', () => {
  const finding = makeFinding('private_host_or_ip', 'fail', {
    file: 'config.yml', line: 1, detail: 'Exposes a private endpoint.',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+endpoint: https://192.168.20.10/private']),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([finding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('');
});

test('keeps a finding for a leak in a real b directory', () => {
  const finding = makeFinding('private_host_or_ip', 'fail', {
    file: 'b/config.yml', line: 1, detail: 'Exposes a private host.',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+host: vault.private.lan'], '@@ -0,0 +1 @@', 'b/config.yml'),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([finding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('');
});

test('accepts a verdict path with the diff header b prefix', () => {
  const finding = makeFinding('private_host_or_ip', 'fail', {
    file: 'b/config.yml', line: 1, detail: 'Exposes a private host.',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'One suspected leak.', findings: [finding] }),
    patch(['+host: vault.private.lan']),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([finding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('');
});

test('matches b-prefixed paths to exact files before trying the b/ alias', () => {
  const configFinding = makeFinding('private_host_or_ip', 'fail', {
    file: 'config.yml', line: 1, detail: '',
  });
  const nestedFinding = makeFinding('private_host_or_ip', 'fail', {
    file: 'b/config.yml', line: 1, detail: '',
  });
  const result = leakResult(
    JSON.stringify({ summary: 'Two suspected leaks.', findings: [configFinding, nestedFinding] }),
    patch(['+host: node-1']) + patch(['+message: ordinary text'], '@@ -0,0 +1 @@', 'b/config.yml'),
  );

  expect(result.validationExit).toBe(0);
  expect(JSON.parse(result.response).findings).toEqual([configFinding]);
  expect(result.renderedExit).toBe('1');
  expect(result.summary).toBe('UNGROUNDED | b/config.yml:1 | no_candidate\n');
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
