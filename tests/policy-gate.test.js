const { expect, test } = require('bun:test');
const { mkdtempSync, rmSync, writeFileSync, readFileSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { execFileSync } = require('child_process');

const script = (name) => join('.github', 'scripts', 'policy-gate', name);

function run(dir, name, env) {
  return Bun.spawnSync(['bash', join(process.cwd(), script(name))], {
    cwd: dir,
    env: { ...process.env, ...env },
  });
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'policy-gate-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withCollectedDiff(content, fn, env = {}) {
  withTempDir((dir) => {
    const git = (args) => execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim();
    git(['init', '-q']);
    const base = git(['commit-tree', git(['write-tree']), '-m', 'base']);
    writeFileSync(join(dir, 'workflow.yml'), content);
    git(['add', 'workflow.yml']);
    const head = git(['commit-tree', git(['write-tree']), '-p', base, '-m', 'head']);
    const raw = execFileSync('git', ['diff', `${base}...${head}`], { cwd: dir });

    const result = run(dir, 'collect.sh', { MAX_DIFF_KB: '150', ...env, BASE_SHA: base, HEAD_SHA: head });

    expect(result.exitCode).toBe(0);
    fn(readFileSync(join(dir, 'diff.txt')), raw);
  });
}

test('render.sh reports the override notice and exits 0 without calling the router', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'override.flag'), '');

    const result = run(dir, 'render.sh', {});

    expect(result.exitCode).toBe(0);
    const body = readFileSync(join(dir, 'policy-gate.md'), 'utf8');
    expect(body).toContain('policy-gate-override');
    expect(readFileSync(join(dir, 'policy-gate.exit'), 'utf8').trim()).toBe('0');
  });
});

test('render.sh renders a passing verdict and marks exit 0', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, 'response.json'),
      JSON.stringify({
        summary: 'No issues found.',
        findings: [
          { check: 'dry', result: 'pass', file: '', line: 0, detail: '' },
          { check: 'native_first', result: 'pass', file: '', line: 0, detail: '' },
          { check: 'disclosure', result: 'pass', file: '', line: 0, detail: '' },
          { check: 'missing_test', result: 'pass', file: '', line: 0, detail: '' },
          { check: 'token_budget', result: 'pass', file: '', line: 0, detail: '' },
        ],
      }),
    );

    const result = run(dir, 'render.sh', { MODEL: 'small', RESPONSE_FILE: join(dir, 'response.json') });

    expect(result.exitCode).toBe(0);
    const body = readFileSync(join(dir, 'policy-gate.md'), 'utf8');
    expect(body).toContain('No issues found.');
    expect(body).toContain('| dry | pass |');
    expect(readFileSync(join(dir, 'policy-gate.exit'), 'utf8').trim()).toBe('0');
  });
});

test('render.sh marks exit 1 when any check fails, and still renders the table', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, 'response.json'),
      JSON.stringify({
        summary: 'One violation.',
        findings: [
          {
            check: 'disclosure',
            result: 'fail',
            file: 'roles/foo/tasks/main.yml',
            line: 12,
            detail: 'names an internal hostname directly',
          },
          { check: 'dry', result: 'pass', file: '', line: 0, detail: '' },
          { check: 'native_first', result: 'pass', file: '', line: 0, detail: '' },
          { check: 'missing_test', result: 'pass', file: '', line: 0, detail: '' },
          { check: 'token_budget', result: 'pass', file: '', line: 0, detail: '' },
        ],
      }),
    );

    const result = run(dir, 'render.sh', { MODEL: 'small', RESPONSE_FILE: join(dir, 'response.json') });

    expect(result.exitCode).toBe(0); // rendering itself never fails the job
    const body = readFileSync(join(dir, 'policy-gate.md'), 'utf8');
    expect(body).toContain('| disclosure | fail | roles/foo/tasks/main.yml | 12 |');
    expect(readFileSync(join(dir, 'policy-gate.exit'), 'utf8').trim()).toBe('1');
  });
});

test('render.sh takes the title and override label from the rubric', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'override.flag'), '');

    const result = run(dir, 'render.sh', { REVIEW_TITLE: 'Leak review', OVERRIDE_LABEL: 'leak-review-override' });

    expect(result.exitCode).toBe(0);
    const body = readFileSync(join(dir, 'policy-gate.md'), 'utf8');
    expect(body).toContain('## Leak review');
    expect(body).toContain('`leak-review-override`');
    expect(body).not.toContain('policy-gate-override');
  });
});

test('collect.sh requires BASE_SHA and HEAD_SHA', () => {
  withTempDir((dir) => {
    const result = run(dir, 'collect.sh', {});
    expect(result.exitCode).not.toBe(0);
  });
});

test('collect.sh marks every secret reference and preserves surrounding diff text', () => {
  withCollectedDiff('values: [${{ secrets.TOKEN }}, ${{secrets._key2}}, ${{\tsecrets.Mixed_123\t}}]\n', (diff, raw) => {
    expect(diff.toString()).toBe(raw.toString()
      .replace('${{ secrets.TOKEN }}', '<secret-reference:TOKEN>')
      .replace('${{secrets._key2}}', '<secret-reference:_key2>')
      .replace('${{\tsecrets.Mixed_123\t}}', '<secret-reference:Mixed_123>'));
  });
});

test('collect.sh preserves a literal token-like value beside a secret reference', () => {
  const literal = 'fixture-token-0123456789abcdef';
  withCollectedDiff(`value: ${literal} ref: \${{ secrets.TOKEN }}\n`, (diff, raw) => {
    expect(diff.toString()).toBe(raw.toString().replace('${{ secrets.TOKEN }}', '<secret-reference:TOKEN>'));
    expect(diff.toString()).toContain(`+value: ${literal} ref: <secret-reference:TOKEN>`);
  });
});

test('collect.sh leaves a diff without secret references byte-identical', () => {
  withCollectedDiff('value:\tplain\nlast line without newline', (diff, raw) => {
    expect(diff).toEqual(raw);
  });
});

test('collect.sh leaves expressions outside the secret reference grammar unchanged', () => {
  withCollectedDiff('values: [${{ secrets.1KEY }}, ${{ secrets.KEY-X }}, ${{ secrets.KEY || "fallback" }}, ${{ vars.KEY }}]\n', (diff, raw) => {
    expect(diff).toEqual(raw);
  });
});

test('collect.sh caps the marked diff and retains the truncation notice', () => {
  withCollectedDiff('ref: ${{ secrets.TOKEN }}\n' + 'value\n'.repeat(300), (diff, raw) => {
    const marked = Buffer.from(raw.toString().replace('${{ secrets.TOKEN }}', '<secret-reference:TOKEN>'));
    expect(diff).toEqual(Buffer.concat([marked.subarray(0, 1024), Buffer.from('\n[diff truncated at 1 KiB]\n')]));
  }, { MAX_DIFF_KB: '1' });
});
