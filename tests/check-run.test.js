const { describe, expect, it } = require('bun:test');
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const script = join('.github', 'scripts', 'shared', 'check-run.sh');
const gatewayScript = join('.github', 'scripts', 'shared', 'gateway-failure.sh');

const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" != api ]; then
  echo "unexpected gh command" >&2
  exit 2
fi
shift
method=GET
if [ "$1" = "-X" ] || [ "$1" = "--method" ]; then
  method="$2"
  shift 2
fi
path="$1"
shift
if [ "$method" = GET ]; then
  {
    printf '%s\\n' "$path"
    printf '%s\\n' "$@"
  } > "$FAKE_GH_LOOKUP"
  if [ "\${FAKE_GH_LOOKUP_MODE:-ok}" = fail ]; then
    echo "fake lookup failure" >&2
    exit 1
  fi
  printf '%s\\n' "$FAKE_GH_RUNS"
  exit 0
fi
body="$(cat)"
printf '%s\\t%s\\t%s\\n' "$method" "$path" "$(printf '%s' "$body" | tr '\\n' ' ')" >> "$FAKE_GH_WRITES"
if [ "\${FAKE_GH_WRITE_MODE:-ok}" = 403 ]; then
  echo "gh: Resource not accessible by integration (HTTP 403)" >&2
  exit 1
fi
echo '{"id":999}'
`;

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), 'check-run-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), fakeGh);
  chmodSync(join(bin, 'gh'), 0o755);
  const paths = {
    dir,
    bin,
    lookup: join(dir, 'lookup.txt'),
    writes: join(dir, 'writes.tsv'),
    summary: join(dir, 'summary.md'),
  };
  writeFileSync(paths.writes, '');
  writeFileSync(paths.summary, '');
  return paths;
}

function invoke(w, command, args, { runs = { check_runs: [] }, lookupMode = 'ok', writeMode = 'ok', extraEnv = {} } = {}) {
  return Bun.spawnSync(['bash', command, ...args], {
    env: {
      PATH: `${w.bin}:${process.env.PATH}`,
      GH_TOKEN: 'gh-test-token',
      GITHUB_REPOSITORY: 'dryvist/example',
      CHECK_HEAD_SHA: 'abc123',
      CHECK_APP_SLUG: 'review-bot',
      FAKE_GH_LOOKUP: w.lookup,
      FAKE_GH_WRITES: w.writes,
      FAKE_GH_RUNS: JSON.stringify(runs),
      FAKE_GH_LOOKUP_MODE: lookupMode,
      FAKE_GH_WRITE_MODE: writeMode,
      GITHUB_STEP_SUMMARY: w.summary,
      ...extraEnv,
    },
  });
}

function writes(w) {
  const text = readFileSync(w.writes, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map((line) => {
    const [method, path, ...bodyParts] = line.split('\t');
    return { method, path, body: JSON.parse(bodyParts.join('\t')) };
  });
}

function runRecord(id, name, appSlug = 'review-bot') {
  return { id, name, app: { slug: appSlug }, conclusion: 'neutral' };
}

describe('shared check-run helper', () => {
  it('POSTs when no run exists and passes the check name through -f', () => {
    const w = workdir();
    const name = 'security review: stable name';
    const result = invoke(w, script, ['upsert', name, 'success', 'Security review', 'No findings.']);
    const request = writes(w)[0];
    const lookup = readFileSync(w.lookup, 'utf8').trim().split('\n');

    expect(result.exitCode).toBe(0);
    expect(request.method).toBe('POST');
    expect(request.path).toBe('repos/dryvist/example/check-runs');
    expect(request.body).toEqual({
      name,
      head_sha: 'abc123',
      status: 'completed',
      conclusion: 'success',
      output: { title: 'Security review', summary: 'No findings.' },
    });
    expect(lookup).toEqual([
      'repos/dryvist/example/commits/abc123/check-runs',
      '-f',
      `check_name=${name}`,
      '-f',
      'filter=latest',
      '-f',
      'per_page=100',
    ]);
  });

  it('PATCHes the latest run from the same app instead of POSTing', () => {
    const w = workdir();
    const name = 'security-review';
    const result = invoke(w, script, ['upsert', name, 'failure', 'Security review', 'Findings.'], {
      runs: {
        check_runs: [
          { ...runRecord(41, name), started_at: '2026-11-01T00:00:00Z' },
          { ...runRecord(44, name), started_at: '2026-11-02T00:00:00Z' },
        ],
      },
    });
    const request = writes(w)[0];

    expect(result.exitCode).toBe(0);
    expect(writes(w)).toHaveLength(1);
    expect(request.method).toBe('PATCH');
    expect(request.path).toBe('repos/dryvist/example/check-runs/44');
    expect(request.body).toEqual({
      status: 'completed',
      conclusion: 'failure',
      output: { title: 'Security review', summary: 'Findings.' },
    });
  });

  it('ignores a same-name run from a different app and POSTs', () => {
    const w = workdir();
    const result = invoke(w, script, ['upsert', 'security-review', 'success', 'Security review', 'Clean.'], {
      runs: { check_runs: [runRecord(42, 'security-review', 'other-app')] },
    });

    expect(result.exitCode).toBe(0);
    expect(writes(w)).toHaveLength(1);
    expect(writes(w)[0].method).toBe('POST');
  });

  it('update with no matching run writes nothing and exits 0', () => {
    const w = workdir();
    const result = invoke(w, script, ['update', 'policy-gate', 'success', 'Policy gate', 'Clean.']);

    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([]);
  });

  it('update PATCHes a matching run', () => {
    const w = workdir();
    const result = invoke(w, script, ['update', 'policy-gate', 'success', 'Policy gate', 'Clean.'], {
      runs: { check_runs: [runRecord(43, 'policy-gate')] },
    });

    expect(result.exitCode).toBe(0);
    expect(writes(w)).toHaveLength(1);
    expect(writes(w)[0]).toEqual({
      method: 'PATCH',
      path: 'repos/dryvist/example/check-runs/43',
      body: {
        status: 'completed',
        conclusion: 'success',
        output: { title: 'Policy gate', summary: 'Clean.' },
      },
    });
  });

  it('falls back to POST with a warning when the lookup fails', () => {
    const w = workdir();
    const result = invoke(w, script, ['upsert', 'security-review', 'neutral', 'Security review', 'gateway unavailable'], {
      lookupMode: 'fail',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('::warning::check-run: the check-run lookup failed');
    expect(writes(w)).toHaveLength(1);
    expect(writes(w)[0].method).toBe('POST');
  });

  it('fails when a write is refused with 403', () => {
    const w = workdir();
    const result = invoke(w, script, ['upsert', 'security-review', 'success', 'Security review', 'Clean.'], {
      writeMode: '403',
    });

    expect(result.exitCode).toBe(1);
  });
});

describe('gateway outage recovery sequence', () => {
  it('posts neutral for a blocking outage, then PATCHes the same check run on recovery', () => {
    const w = workdir();
    const outage = invoke(w, gatewayScript, ['report', 'security-review', 'router-request-failed'], {
      extraEnv: { GITHUB_TOKEN: 'gh-test-token', CHECK_NAME: 'security-review', CONCLUSION: 'failure' },
    });
    const initialWrite = writes(w)[0];
    const recovered = invoke(w, script, ['upsert', 'security-review', 'success', 'Security review', 'Recovered.'], {
      runs: { check_runs: [runRecord(999, 'security-review')] },
    });
    const recoveryWrite = writes(w)[1];

    expect(outage.exitCode).toBe(1);
    expect(initialWrite.method).toBe('POST');
    expect(initialWrite.path).toBe('repos/dryvist/example/check-runs');
    expect(initialWrite.body.name).toBe('security-review');
    expect(initialWrite.body.conclusion).toBe('neutral');
    expect(recovered.exitCode).toBe(0);
    expect(recoveryWrite.method).toBe('PATCH');
    expect(recoveryWrite.path).toBe('repos/dryvist/example/check-runs/999');
    expect(writes(w)).toHaveLength(2);
  });
});
