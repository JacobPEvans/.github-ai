const { expect, test } = require('bun:test');
const { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } = require('fs');
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

function withCollectedDiff(content, fn, env = {}, baseContent) {
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
    if (baseContent !== undefined) {
      writeFileSync(join(dir, 'workflow.yml'), baseContent);
      git(['add', 'workflow.yml']);
    }
    const base = git(['commit-tree', git(['write-tree']), '-m', 'base']);
    writeFileSync(join(dir, 'workflow.yml'), content);
    git(['add', 'workflow.yml']);
    const head = git(['commit-tree', git(['write-tree']), '-p', base, '-m', 'head']);
    const raw = execFileSync('git', ['diff', ...(env.RUBRIC === 'leak' ? ['--unified=0'] : []), `${base}...${head}`], { cwd: dir });

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

test('render.sh renders a failed code verdict like a failed security verdict', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, 'response.json'),
      JSON.stringify({
        summary: 'One violation.',
        findings: [
          {
            check: 'regression',
            result: 'fail',
            file: 'roles/foo/tasks/main.yml',
            line: 4,
            detail: 'drops the retry the old task had',
          },
          { check: 'correctness', result: 'pass', file: '', line: 0, detail: '' },
          { check: 'missing_test', result: 'pass', file: '', line: 0, detail: '' },
          { check: 'native_first', result: 'pass', file: '', line: 0, detail: '' },
        ],
      }),
    );

    const result = run(dir, 'render.sh', { MODEL: 'small', RESPONSE_FILE: join(dir, 'response.json') });

    expect(result.exitCode).toBe(0); // rendering itself never fails the job
    const body = readFileSync(join(dir, 'policy-gate.md'), 'utf8');
    expect(body).toContain('| regression | fail | roles/foo/tasks/main.yml | 4 |');
    expect(body).toContain('_Router role `small`._'); // the non-leak footer, as for security
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

test('collect.sh replaces reference-only additions for leak without changing line counts', () => {
  const content = [
    '  API_KEY: ${{ secrets.API_KEY }}',
    'KEY=${{secrets.TOKEN}}',
    '\tkey.name-2: "${{ secrets._key2 }}"  ',
    "_KEY='${{ secrets.Mixed_123 }}'",
    'QUOTED= "<secret-reference:TOKEN>"',
    "PADDED: ' <secret-reference:TOKEN> '\t",
  ].join('\n') + '\n';
  withCollectedDiff(content, (diff, raw) => {
    const expected = raw.toString().split('\n')
      .map((line) => line.startsWith('+') && !line.startsWith('+++') ? '+<reference-only line>' : line)
      .join('\n');
    expect(diff.toString()).toBe(expected);
    expect(diff.toString().split('\n')).toHaveLength(raw.toString().split('\n').length);
    expect(diff.toString()).not.toContain('<secret-reference:');
  }, { RUBRIC: 'leak' });
});

test.each(['security', 'semantic', 'policy', 'code'])('collect.sh preserves reference-only lines for %s', (rubric) => {
  withCollectedDiff('  API_KEY: ${{ secrets.API_KEY }}\n', (diff, raw) => {
    expect(diff.toString()).toBe(raw.toString().replace('${{ secrets.API_KEY }}', '<secret-reference:API_KEY>'));
  }, { RUBRIC: rubric });
});

test('collect.sh omits reference-only context and preserves removals for leak', () => {
  const context = 'CONTEXT: ${{ secrets.TOKEN }}\n';
  withCollectedDiff(context + 'ADDED: ${{ secrets.TOKEN }}\n', (diff, raw) => {
    expect(diff.toString()).toBe(raw.toString()
      .replaceAll('${{ secrets.TOKEN }}', '<secret-reference:TOKEN>')
      .replace('+ADDED: <secret-reference:TOKEN>', '+<reference-only line>'));
    expect(diff.toString()).not.toMatch(/^ /m);
    expect(diff.toString()).toContain('@@ -2 +2 @@');
    expect(diff.toString()).toContain('-REMOVED: <secret-reference:TOKEN>');
  }, { RUBRIC: 'leak' }, context + 'REMOVED: ${{ secrets.TOKEN }}\n');
});

test.each(['leak', 'security', 'semantic', 'policy', 'code', undefined])('collect.sh selects context for %s and preserves added lines and hunk coordinates', (rubric) => {
  const before = 'permissions:\n  pull-requests: write\n  uses: example/action@v1\n  env:\n    API_KEY: ${{ secrets.API_KEY }}\n';
  const after = before.replace('@v1', '@v2');
  withCollectedDiff(after, (diff, raw) => {
    expect(diff.toString()).toBe(raw.toString().replace('${{ secrets.API_KEY }}', '<secret-reference:API_KEY>'));
    expect(diff.toString()).toContain('+  uses: example/action@v2\n');
    if (rubric === 'leak') {
      expect(diff.toString()).toContain('@@ -3 +3 @@');
      expect(diff.toString()).not.toContain('pull-requests: write');
      expect(diff.toString()).not.toContain('API_KEY');
    } else {
      expect(diff.toString()).toContain('@@ -1,5 +1,5 @@');
      expect(diff.toString()).toContain('   pull-requests: write\n');
      expect(diff.toString()).toContain('     API_KEY: <secret-reference:API_KEY>\n');
    }
  }, { RUBRIC: rubric }, before);
});

test('collect.sh preserves literal text and non-assignment additions for leak', () => {
  const content = [
    'KEY: fixture-token-0123456789abcdef <secret-reference:TOKEN>',
    'KEY: "<secret-reference:TOKEN>suffix"',
    'KEY=<secret-reference:TOKEN> # comment',
    'KEY=<secret-reference:TOKEN><secret-reference:OTHER>',
    'KEY=${{ secrets.TOKEN }} literal',
    '1KEY=<secret-reference:TOKEN>',
    '- KEY: <secret-reference:TOKEN>',
    '<secret-reference:TOKEN>',
  ].join('\n') + '\n';
  withCollectedDiff(content, (diff, raw) => {
    expect(diff.toString()).toBe(raw.toString().replace('${{ secrets.TOKEN }}', '<secret-reference:TOKEN>'));
  }, { RUBRIC: 'leak' });
});

test('collect.sh puts each reusable workflow a changed workflow calls in front of the security diff only', () => {
  const collect = (rubric, curlExit = 0) => withTempDir((dir) => {
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
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, '.github', 'workflows', 'caller.yml'), [
      'jobs:',
      '  fix:',
      '    uses: o/r/.github/workflows/called.yml@v2',
      '  again:',
      '    uses: o/r/.github/workflows/called.yml@v2',
      '  local:',
      '    uses: ./.github/workflows/local.yml',
      '',
    ].join('\n'));
    git(['add', '.github']);
    const head = git(['commit-tree', git(['write-tree']), '-p', base, '-m', 'head']);
    // The stub writes the requested URL as the file, so the test sees which ref was read.
    writeFileSync(join(dir, 'bin', 'curl'), `#!/bin/sh\nout=\nurl=\nwhile [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; http*) url=$1 ;; esac; shift; done\nprintf "called body for %s" "$url" > "$out"\nexit ${curlExit}\n`);
    chmodSync(join(dir, 'bin', 'curl'), 0o755);
    const result = run(dir, 'collect.sh', {
      RUBRIC: rubric, BASE_SHA: base, HEAD_SHA: head, MAX_DIFF_KB: '150',
      GH_TOKEN: 't', API_URL: 'https://api.example.test', PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return { diff: readFileSync(join(dir, 'diff.txt'), 'utf8'), stdout: result.stdout.toString() };
  });

  const { diff } = collect('security');
  expect(diff.startsWith('CALLED REUSABLE WORKFLOW o/r/.github/workflows/called.yml@v2, context only and not part of this pull request')).toBe(true);
  expect(diff).toContain('called body for https://api.example.test/repos/o/r/contents/.github/workflows/called.yml?ref=v2');
  expect(diff.match(/CALLED REUSABLE WORKFLOW/g)).toHaveLength(1);
  expect(diff).not.toContain('local.yml?ref');
  expect(diff.indexOf('end of called reusable workflow')).toBeLessThan(diff.indexOf('diff --git'));
  expect(collect('policy').diff.startsWith('diff --git')).toBe(true);
  const unreadable = collect('security', 22);
  expect(unreadable.diff.startsWith('diff --git')).toBe(true);
  expect(unreadable.stdout).toContain('::warning::could not read the called workflow o/r/.github/workflows/called.yml@v2');
});
