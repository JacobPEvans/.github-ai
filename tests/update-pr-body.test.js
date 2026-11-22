const { describe, it, expect, mock } = require('bun:test');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createMockCore, createMockContext } = require('./helpers.js');

const run = require('../.github/scripts/ci-fix/update-pr-body.js');

async function update(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-body-'));
  const file = join(dir, 'pr-body.md');
  if (contents !== null) writeFileSync(file, contents);
  const update = mock(async () => ({}));
  process.env.PR_BODY_FILE = file;
  process.env.PR_NUMBER = '42';
  try {
    await run({ github: { rest: { pulls: { update } } }, context: createMockContext(), core: createMockCore() });
  } finally {
    delete process.env.PR_BODY_FILE;
    delete process.env.PR_NUMBER;
    rmSync(dir, { recursive: true, force: true });
  }
  return update.mock.calls.map((call) => call[0]);
}

describe('update-pr-body', () => {
  it('sets the description the agent wrote', async () => {
    expect(await update('## Changes\n\nAdds a task file.\n')).toEqual([
      { owner: 'test-owner', repo: 'test-repo', pull_number: 42, body: '## Changes\n\nAdds a task file.' },
    ]);
  });

  it('changes nothing with no file, an empty file or an oversized one', async () => {
    expect(await update(null)).toEqual([]);
    expect(await update(' \n')).toEqual([]);
    expect(await update('x'.repeat(60001))).toEqual([]);
  });
});
