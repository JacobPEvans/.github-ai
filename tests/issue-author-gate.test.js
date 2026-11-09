const { expect, test } = require('bun:test');
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  TRUSTED_AUTHOR_ASSOCIATIONS,
  filterTrustedComments,
  filterTrustedIssues,
  isTrustedAuthorAssociation,
} = require('../.github/scripts/issue-author-gate/authors.js');

const workflow = (filename) => Bun.YAML.parse(readFileSync(join('.github', 'workflows', filename), 'utf8'));
const stepIndex = (job, name) => job.steps.findIndex(step => step.name === name);
const issueFixture = (number, authorAssociation, body) => ({
  author_association: authorAssociation,
  body,
  created_at: `2026-01-0${number}T00:00:00Z`,
  html_url: `https://github.com/test-owner/test-repo/issues/${number}`,
  labels: [],
  number,
  state: 'open',
  title: `Issue ${number}`,
  user: { login: `author-${number}` },
});

function trustedAssociationsFrom(expression) {
  const match = expression.match(/fromJSON\('([^']+)'\)/);
  expect(match).not.toBeNull();
  return JSON.parse(match[1]);
}

function makeFakeGh(directory) {
  const executable = join(directory, 'fake-gh');
  const source = [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2);",
    'const data = JSON.parse(process.env.FAKE_GH_DATA);',
    "const endpoint = args.find(value => value.startsWith('repos/')) || '';",
    "if (endpoint.endsWith('/comments')) process.stdout.write(JSON.stringify([data.comments]));",
    "else if (/\\/issues\\/\\d+$/.test(endpoint)) {",
    "  const number = Number(endpoint.split('/').at(-1));",
    '  process.stdout.write(JSON.stringify(data.issues.find(issue => issue.number === number)));',
    '} else process.stdout.write(JSON.stringify([data.issues]));',
  ].join('\n');
  writeFileSync(executable, source);
  chmodSync(executable, 0o755);
  return executable;
}

test('trusted associations are exactly OWNER, MEMBER, and COLLABORATOR', () => {
  expect(TRUSTED_AUTHOR_ASSOCIATIONS).toEqual(['OWNER', 'MEMBER', 'COLLABORATOR']);
  for (const association of TRUSTED_AUTHOR_ASSOCIATIONS) {
    expect(isTrustedAuthorAssociation(association)).toBe(true);
  }
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', 'BOT', null]) {
    expect(isTrustedAuthorAssociation(association)).toBe(false);
  }
});

test('issue-triage skips an untrusted trigger before allocating its agent job', () => {
  const job = workflow('issue-triage.yml').jobs.triage;
  const associations = trustedAssociationsFrom(job.if);
  const allowed = (issueAuthor, commentAuthor = null, inputIssue = '0', eventIssue = 5) =>
    associations.includes(issueAuthor)
    && (!commentAuthor || associations.includes(commentAuthor))
    && (inputIssue === '0' || Number(inputIssue) === eventIssue);

  expect(job.if).toContain('github.event.issue.author_association');
  expect(job.if).toContain('github.event.comment.author_association');
  expect(job.if).toContain('inputs.issue_number == github.event.issue.number');
  expect(allowed('OWNER')).toBe(true);
  expect(allowed('CONTRIBUTOR')).toBe(false);
  expect(allowed('OWNER', 'CONTRIBUTOR')).toBe(false);
  expect(allowed('OWNER', 'MEMBER', '9', 5)).toBe(false);
});

test('issue-triage agent reads use the trusted issue reader', () => {
  const job = workflow('issue-triage.yml').jobs.triage;
  const prepare = stepIndex(job, 'Prepare trusted issue reader');
  const agent = stepIndex(job, 'Run AI agent');
  expect(prepare).toBeGreaterThanOrEqual(0);
  expect(prepare).toBeLessThan(agent);
  expect(job.steps[prepare].with.script).toContain('issue-author-gate/prepare.js');
  expect(job.steps[agent].with.allowed_tools).toContain('Bash(gh issue list:*)');
  expect(job.steps[agent].with.allowed_tools).not.toContain('Bash(gh search:*)');
});

test('cc-issue-resolver skips issues and comments unless both authors are trusted', () => {
  const parsed = workflow('cc-issue-resolver.yml');
  const script = readFileSync('.github/scripts/issue-resolver/check-eligibility.js', 'utf8');
  expect(parsed.jobs.resolve.if).toContain("needs.eligibility-check.outputs.should_run == 'true'");
  expect(script).toContain("require('../issue-author-gate/authors')");
  expect(script).toContain('isTrustedAuthorAssociation(issue.author_association)');
  expect(script).toContain('isTrustedAuthorAssociation(context.payload.comment.author_association)');
  // Kept so existing callers that pass it still validate; nothing reads it.
  expect(parsed.on.workflow_call.inputs.allowed_authors.description).toContain('ignored');
  expect(JSON.stringify(parsed.jobs)).not.toContain('allowed_authors');
  expect(script).not.toContain('ALLOWED_AUTHORS');
});

const sweepWorkflows = [
  ['issue-backlog-sweep.yml', 'sweep'],
  ['issue-sweeper.yml', 'sweep'],
  ['issue-hygiene.yml', 'hygiene'],
];

for (const [filename, jobName] of sweepWorkflows) {
  test(`${filename} passes trusted issues to its agent and omits untrusted issue text`, () => {
    const job = workflow(filename).jobs[jobName];
    const prepare = stepIndex(job, 'Prepare trusted issue reader');
    const agent = stepIndex(job, 'Run AI agent');
    const { trusted, skipped } = filterTrustedIssues([
      issueFixture(1, 'OWNER', 'trusted owner issue'),
      issueFixture(2, 'MEMBER', 'trusted member issue'),
      issueFixture(3, 'COLLABORATOR', 'trusted collaborator issue'),
      issueFixture(4, 'CONTRIBUTOR', 'untrusted issue text'),
    ]);

    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeLessThan(agent);
    expect(job.steps[prepare].with.script).toContain('issue-author-gate/prepare.js');
    expect(job.permissions.issues).toBe('read');
    expect(trusted.map(issue => issue.body)).toContain('trusted owner issue');
    expect(trusted.map(issue => issue.body)).toContain('trusted member issue');
    expect(trusted.map(issue => issue.body)).toContain('trusted collaborator issue');
    expect(JSON.stringify(trusted)).not.toContain('untrusted issue text');
    expect(skipped).toBe(1);
  });
}

test('trusted issue reads filter issue bodies and comment bodies before tool output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'issue-author-gate-'));
  const issue = issueFixture(1, 'OWNER', 'trusted issue body');
  const untrusted = issueFixture(2, 'CONTRIBUTOR', 'untrusted issue body');
  const fixture = {
    comments: [
      { author_association: 'MEMBER', body: 'trusted comment body', created_at: '2026-01-02T00:00:00Z', user: { login: 'member' } },
      { author_association: 'CONTRIBUTOR', body: 'untrusted comment body', created_at: '2026-01-03T00:00:00Z', user: { login: 'contributor' } },
    ],
    issues: [issue, untrusted],
  };
  const fakeGh = makeFakeGh(directory);
  const env = {
    ...process.env,
    FAKE_GH_DATA: JSON.stringify(fixture),
    GITHUB_REPOSITORY: 'test-owner/test-repo',
    GH_REAL_PATH: fakeGh,
  };

  try {
    const list = spawnSync(process.execPath, [
      '.github/scripts/issue-author-gate/gh', 'issue', 'list',
      '--json', 'number,title,body,author', '--limit', '100',
    ], { encoding: 'utf8', env });
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('trusted issue body');
    expect(list.stdout).not.toContain('untrusted issue body');
    expect(list.stderr).toContain('Skipped 1 untrusted issue.');

    const view = spawnSync(process.execPath, [
      '.github/scripts/issue-author-gate/gh', 'issue', 'view', '1', '--comments',
    ], { encoding: 'utf8', env });
    expect(view.status).toBe(0);
    expect(view.stdout).toContain('trusted issue body');
    expect(view.stdout).toContain('trusted comment body');
    expect(view.stdout).not.toContain('untrusted issue body');
    expect(view.stdout).not.toContain('untrusted comment body');
    expect(view.stderr).toContain('Skipped 1 untrusted comment.');

    const blocked = spawnSync(process.execPath, [
      '.github/scripts/issue-author-gate/gh', 'issue', 'view', '2',
    ], { encoding: 'utf8', env });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stdout).not.toContain('untrusted issue body');

    const rawApi = spawnSync(process.execPath, [
      '.github/scripts/issue-author-gate/gh', 'api', '--method', 'GET',
      'repos/test-owner/test-repo/issues',
    ], { encoding: 'utf8', env });
    expect(rawApi.status).not.toBe(0);
    expect(rawApi.stdout).toBe('');

    const inputApi = spawnSync(process.execPath, [
      '.github/scripts/issue-author-gate/gh', 'api', '--method', 'GET',
      '--input', 'query.json', 'graphql',
    ], { encoding: 'utf8', env });
    expect(inputApi.status).not.toBe(0);
    expect(inputApi.stdout).toBe('');

    const unknownOption = spawnSync(process.execPath, [
      '.github/scripts/issue-author-gate/gh', 'api', '--unsupported', 'value',
      'repos/test-owner/test-repo/issues',
    ], { encoding: 'utf8', env });
    expect(unknownOption.status).not.toBe(0);
    expect(unknownOption.stdout).toBe('');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('issue list filtering fails closed when GitHub omits author_association', () => {
  expect(() => filterTrustedIssues([{ number: 5, body: 'unclassified' }])).toThrow('author_association');
  expect(filterTrustedComments([{ body: 'unclassified comment' }]).trusted).toEqual([]);
});

test('raw issue API and GraphQL routes cannot bypass the trusted issue reader', () => {
  const safeGh = require('../.github/scripts/issue-author-gate/gh');
  expect(safeGh.isIssueApiEndpoint('repos/test/test/issues')).toBe(true);
  expect(safeGh.isIssueApiEndpoint('search/issues')).toBe(true);
  expect(safeGh.isIssueApiEndpoint('graphql')).toBe(true);
  expect(safeGh.isIssueApiEndpoint('repos/test/test/pulls')).toBe(false);
});
