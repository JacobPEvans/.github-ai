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
const { checkIssueAuthor } = require('../.github/scripts/issue-author-gate/check-issue-author.js');

const WORKFLOW_REPOSITORY_ERROR = 'Issue reads are restricted to the workflow repository.';
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

function runGh(args, data = { comments: [], issues: [] }, repository = 'test-owner/test-repo', extraEnvironment = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'issue-author-gate-'));
  const fakeGh = makeFakeGh(directory);
  try {
    const env = {
      ...process.env,
      ...extraEnvironment,
      FAKE_GH_DATA: JSON.stringify(data),
      GITHUB_REPOSITORY: repository,
      GH_REAL_PATH: fakeGh,
    };
    if (!Object.hasOwn(extraEnvironment, 'GH_REPO')) delete env.GH_REPO;
    return spawnSync(process.execPath, [
      '.github/scripts/issue-author-gate/gh', ...args,
    ], {
      encoding: 'utf8',
      env,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test('workflow_dispatch gates triage on the trusted author read through the API', async () => {
  const parsed = workflow('issue-triage.yml');
  const { gate, triage } = parsed.jobs;
  const eligibilityCheckout = workflow('cc-issue-resolver.yml').jobs['eligibility-check'].steps[0];
  const calls = [];
  const outputs = {};
  const context = { payload: {}, repo: { owner: 'test-owner', repo: 'test-repo' } };
  const github = {
    rest: {
      issues: {
        get: async (request) => {
          calls.push(request);
          return { data: issueFixture(42, 'MEMBER', 'trusted issue body') };
        },
      },
    },
  };
  const trusted = await checkIssueAuthor({
    github,
    context,
    core: { setOutput: (name, value) => { outputs[name] = value; } },
    inputIssueNumber: '42',
  });

  expect(parsed.on.workflow_dispatch.inputs.issue_number.type).toBe('string');
  expect(parsed.on.workflow_dispatch.inputs.issue_number.default).toBe('0');
  expect(calls).toEqual([{ owner: 'test-owner', repo: 'test-repo', issue_number: 42 }]);
  expect(trusted).toBe(true);
  expect(outputs.trusted).toBe('true');
  expect(gate.permissions).toEqual({ issues: 'read' });
  expect(gate.secrets).toBeUndefined();
  expect(gate.outputs.trusted).toContain('steps.check.outputs.trusted');
  expect(gate.steps[0].uses).toBe(eligibilityCheckout.uses);
  expect(gate.steps[0].with).toEqual(eligibilityCheckout.with);
  expect(gate.steps[1].with.script).toContain('issue-author-gate/check-issue-author.js');
  expect(triage.needs).toBe('gate');
  expect(triage.if).toBe("needs.gate.outputs.trusted == 'true'");
});

test('workflow_dispatch skips triage for an untrusted API issue author', async () => {
  const calls = [];
  const outputs = {};
  const trusted = await checkIssueAuthor({
    github: {
      rest: {
        issues: {
          get: async (request) => {
            calls.push(request);
            return { data: issueFixture(43, 'CONTRIBUTOR', 'untrusted issue body') };
          },
        },
      },
    },
    context: { payload: {}, repo: { owner: 'test-owner', repo: 'test-repo' } },
    core: { setOutput: (name, value) => { outputs[name] = value; } },
    inputIssueNumber: '43',
  });

  expect(calls[0].issue_number).toBe(43);
  expect(trusted).toBe(false);
  expect(outputs.trusted).toBe('false');
});

test('an untrusted triggering comment blocks an API-trusted issue author', async () => {
  const calls = [];
  const outputs = {};
  const trusted = await checkIssueAuthor({
    github: {
      rest: {
        issues: {
          get: async (request) => {
            calls.push(request);
            return { data: issueFixture(44, 'OWNER', 'trusted issue body') };
          },
        },
      },
    },
    context: {
      payload: {
        issue: { number: 44, author_association: 'OWNER' },
        comment: { author_association: 'CONTRIBUTOR' },
      },
      repo: { owner: 'test-owner', repo: 'test-repo' },
    },
    core: { setOutput: (name, value) => { outputs[name] = value; } },
    inputIssueNumber: '0',
  });

  expect(calls[0].issue_number).toBe(44);
  expect(trusted).toBe(false);
  expect(outputs.trusted).toBe('false');
});

test('an unreadable issue or missing API author association fails closed', async () => {
  const makeGate = (getIssue) => {
    const outputs = {};
    return {
      outputs,
      run: checkIssueAuthor({
        github: { rest: { issues: { get: getIssue } } },
        context: { payload: {}, repo: { owner: 'test-owner', repo: 'test-repo' } },
        core: { setOutput: (name, value) => { outputs[name] = value; } },
        inputIssueNumber: '45',
      }),
    };
  };
  const unreadable = makeGate(async () => { throw new Error('API unavailable'); });
  expect(await unreadable.run).toBe(false);
  expect(unreadable.outputs.trusted).toBe('false');

  const unclassified = makeGate(async () => ({ data: { number: 45 } }));
  expect(await unclassified.run).toBe(false);
  expect(unclassified.outputs.trusted).toBe('false');
});

test('issue-triage agent reads use the trusted issue reader', () => {
  const job = workflow('issue-triage.yml').jobs.triage;
  const prepare = stepIndex(job, 'Prepare trusted issue reader');
  const agent = stepIndex(job, 'Run AI agent');
  const checkout = job.steps.find(step => step.name === 'Checkout ai-workflows');
  expect(prepare).toBeGreaterThanOrEqual(0);
  expect(prepare).toBeLessThan(agent);
  expect(job.steps[prepare].uses).toBe('./.ai-workflows/.github/actions/trusted-issue-reader');
  expect(checkout.with['sparse-checkout']).toContain('.github/actions/trusted-issue-reader');
  expect(job.steps[agent].with.allowed_tools).toContain('Bash(gh issue list:*)');
  expect(job.steps[agent].with.allowed_tools).not.toContain('Bash(gh search:*)');
});

const genericIssueSearchWorkflows = [
  ['cc-code-simplifier.yml', 'simplify'],
  ['cc-post-merge-docs-review.yml', 'post-merge-docs-review'],
  ['cc-post-merge-tests.yml', 'post-merge-tests'],
];

for (const [filename, jobName] of genericIssueSearchWorkflows) {
  test(`${filename} does not allow generic gh search`, () => {
    const job = workflow(filename).jobs[jobName];
    const agent = job.steps.find(step => step.name === 'Run AI agent');
    const allowedTools = agent.with.allowed_tools.split(',');

    expect(allowedTools.filter(tool => tool.startsWith('Bash(gh search'))).toEqual([]);
  });
}

test('cc-dep-review only allows release-by-tag API reads', () => {
  const agent = workflow('cc-dep-review.yml').jobs.review.steps.find(step => step.name === 'Run AI agent');
  const allowedTools = agent.with.allowed_tools.split(',');
  const apiTools = allowedTools.filter(tool => tool.startsWith('Bash(gh api'));

  expect(apiTools).toEqual(['Bash(gh api repos/*/*/releases/tags/*)']);
  expect(apiTools.some(tool => /issues|comments/i.test(tool))).toBe(false);
});

test('trusted issue reader composite action runs the shared setup', () => {
  const action = Bun.YAML.parse(readFileSync('.github/actions/trusted-issue-reader/action.yml', 'utf8'));
  const prepare = action.runs.steps[0];
  expect(action.runs.using).toBe('composite');
  expect(prepare.uses).toBe('actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3');
  expect(prepare.with.script).toContain('./.ai-workflows/.github/scripts/issue-author-gate/prepare.js');
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
    const checkout = job.steps.find(step => step.name === 'Checkout ai-workflows');
    const { trusted, skipped } = filterTrustedIssues([
      issueFixture(1, 'OWNER', 'trusted owner issue'),
      issueFixture(2, 'MEMBER', 'trusted member issue'),
      issueFixture(3, 'COLLABORATOR', 'trusted collaborator issue'),
      issueFixture(4, 'CONTRIBUTOR', 'untrusted issue text'),
    ]);

    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeLessThan(agent);
    expect(job.steps[prepare].uses).toBe('./.ai-workflows/.github/actions/trusted-issue-reader');
    expect(checkout.with['sparse-checkout']).toContain('.github/actions/trusted-issue-reader');
    expect(job.permissions.issues).toBe('read');
    expect(trusted.map(issue => issue.body)).toContain('trusted owner issue');
    expect(trusted.map(issue => issue.body)).toContain('trusted member issue');
    expect(trusted.map(issue => issue.body)).toContain('trusted collaborator issue');
    expect(JSON.stringify(trusted)).not.toContain('untrusted issue text');
    expect(skipped).toBe(1);
  });
}

const additionalIssueReaders = [
  ['issue-linker.yml', 'link-issues'],
  ['best-practices.yml', 'best-practices'],
  ['cc-next-steps.yml', 'analyze'],
];

for (const [filename, jobName] of additionalIssueReaders) {
  test(`${filename} routes issue reads through the trusted reader`, () => {
    const job = workflow(filename).jobs[jobName];
    const prepare = stepIndex(job, 'Prepare trusted issue reader');
    const agent = stepIndex(job, 'Run AI agent');
    const checkout = job.steps.find(step => step.name === 'Checkout ai-workflows');
    const allowedTools = job.steps.map(step => step.with?.allowed_tools || '').join(',');
    const scripts = job.steps.map(step => [step.run, step.with?.script].filter(Boolean).join('\n')).join('\n');

    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeLessThan(agent);
    expect(job.steps[prepare].uses).toBe('./.ai-workflows/.github/actions/trusted-issue-reader');
    expect(checkout.with['sparse-checkout']).toContain('.github/actions/trusted-issue-reader');
    expect(allowedTools).toContain('Bash(gh issue list:*)');
    expect(allowedTools).toContain('Bash(gh issue view:*)');
    expect(allowedTools).not.toContain('Bash(gh api');
    expect(allowedTools).not.toContain('Bash(gh search issues:*)');
    expect(allowedTools).not.toContain('Bash(gh search:*)');
    expect(scripts).not.toMatch(/\bgh api\b/i);
    expect(scripts).not.toMatch(/\bgh search issues\b/i);
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

const rawIssueApiBypasses = [
  ['query strings', ['api', 'repos/test-owner/test-repo/issues?state=open']],
  ['fragments', ['api', 'repos/test-owner/test-repo/issues#comments']],
  ['encoded slashes', ['api', 'repos/test-owner/test-repo%2Fissues']],
  ['encoded issue names', ['api', 'repos/test-owner/test-repo/%69ssues']],
  ['trailing slashes', ['api', 'repos/test-owner/test-repo/issues/']],
  ['mixed case paths', ['api', 'Repos/Test-Owner/Test-Repo/Issues']],
  ['absolute URLs', ['api', 'https://api.github.com/repos/test-owner/test-repo/issues?state=open']],
  ['--input arguments', ['api', '--input', 'query.json', 'repos/test-owner/test-repo/issues']],
  ['-f arguments', ['api', '-f', 'state=open', 'repos/test-owner/test-repo/issues']],
];

for (const [bypass, args] of rawIssueApiBypasses) {
  test(`gh api rejects issue reads with ${bypass}`, () => {
    const result = runGh(args);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Issue API reads are restricted');
  });
}

test('issue view keeps a URL repository and rejects URLs outside the current repository', () => {
  const issue = issueFixture(7, 'OWNER', 'trusted issue from URL repository');
  const fixture = { comments: [], issues: [issue] };
  const sameRepository = runGh([
    'issue', 'view', 'https://github.com/test-owner/test-repo/issues/7',
  ], fixture);
  expect(sameRepository.status).toBe(0);
  expect(sameRepository.stdout).toContain('trusted issue from URL repository');

  const otherRepository = runGh([
    'issue', 'view', 'https://github.com/other-owner/other-repo/issues/7',
  ], fixture);
  expect(otherRepository.status).not.toBe(0);
  expect(otherRepository.stdout).toBe('');
  expect(otherRepository.stderr.trim()).toBe(WORKFLOW_REPOSITORY_ERROR);

  const explicitlySelectedOtherRepository = runGh([
    'issue', 'view', 'https://github.com/other-owner/other-repo/issues/7',
    '--repo', 'other-owner/other-repo',
  ], fixture);
  expect(explicitlySelectedOtherRepository.status).not.toBe(0);
  expect(explicitlySelectedOtherRepository.stdout).toBe('');
  expect(explicitlySelectedOtherRepository.stderr.trim()).toBe(WORKFLOW_REPOSITORY_ERROR);
});

const repositoryReadFixture = {
  comments: [],
  issues: [
    issueFixture(1, 'OWNER', 'trusted issue body'),
    issueFixture(2, 'CONTRIBUTOR', 'untrusted issue body'),
  ],
};

const alternateRepositoryArguments = [
  ['--repo', ['--repo', 'other-owner/other-repo']],
  ['-R', ['-R', 'other-owner/other-repo']],
];

for (const [option, selection] of alternateRepositoryArguments) {
  test(`gh issue list and view refuse a different repository through ${option}`, () => {
    for (const args of [
      ['issue', 'list', ...selection],
      ['issue', 'view', '1', ...selection],
    ]) {
      const result = runGh(args, repositoryReadFixture);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe(WORKFLOW_REPOSITORY_ERROR);
    }
  });
}

test('gh issue list and view refuse a different GH_REPO without falling through to native gh', () => {
  for (const args of [
    ['issue', 'list'],
    ['issue', 'view', '1'],
  ]) {
    const result = runGh(args, repositoryReadFixture, 'test-owner/test-repo', {
      GH_REPO: 'other-owner/other-repo',
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe(WORKFLOW_REPOSITORY_ERROR);
  }
});

const workflowRepositorySelections = [
  ['--repo', ['--repo', 'test-owner/test-repo'], {}],
  ['-R', ['-R', 'test-owner/test-repo'], {}],
  ['GH_REPO', [], { GH_REPO: 'test-owner/test-repo' }],
];

for (const [selectionName, selection, extraEnvironment] of workflowRepositorySelections) {
  test(`gh issue list and view keep trusted-author filtering with the workflow ${selectionName}`, () => {
    const list = runGh([
      'issue', 'list', '--json', 'number,body', ...selection,
    ], repositoryReadFixture, 'test-owner/test-repo', extraEnvironment);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('trusted issue body');
    expect(list.stdout).not.toContain('untrusted issue body');

    const trustedView = runGh([
      'issue', 'view', '1', ...selection,
    ], repositoryReadFixture, 'test-owner/test-repo', extraEnvironment);
    expect(trustedView.status).toBe(0);
    expect(trustedView.stdout).toContain('trusted issue body');

    const untrustedView = runGh([
      'issue', 'view', '2', ...selection,
    ], repositoryReadFixture, 'test-owner/test-repo', extraEnvironment);
    expect(untrustedView.status).not.toBe(0);
    expect(untrustedView.stdout).not.toContain('untrusted issue body');
  });
}
