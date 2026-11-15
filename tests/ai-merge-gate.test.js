const { expect, test } = require('bun:test');
const { spawnSync } = require('child_process');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'ai-merge-gate.json'), 'utf8'));
const workflow = (name) => Bun.YAML.parse(readFileSync(join('.github', 'workflows', name), 'utf8'));
const frontdoor = workflow('ai-merge-gate.yml');
const gate = workflow('_ai-merge-gate.yml');
const policy = workflow('policy-gate.yml');
const stepById = (id) => gate.jobs.gate.steps.find((step) => step.id === id);
const stepByName = (name) => gate.jobs.gate.steps.find((step) => step.name === name);

const readOutputs = (file) =>
  Object.fromEntries(
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const eq = line.indexOf('=');
        return [line.slice(0, eq), line.slice(eq + 1)];
      }),
  );

// Prepares a scratch workspace whose .ai-workflows scripts resolve to the
// real ones - policy-gate through a symlink, shared as a real directory so a
// stub written there never lands in the repository through the link. The
// caller removes dir.
function withGateWorkspace(run) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-gate-'));
  const scripts = join(dir, '.ai-workflows', '.github', 'scripts');
  mkdirSync(join(scripts, 'shared'), { recursive: true });
  symlinkSync(join(process.cwd(), '.github', 'scripts', 'policy-gate'), join(scripts, 'policy-gate'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runGateStep(stepId, dir, env) {
  const output = join(dir, 'step-output');
  writeFileSync(output, '');
  const result = Bun.spawnSync(['/bin/bash', '-c', stepById(stepId).run], {
    cwd: dir,
    env: { ...process.env, GITHUB_OUTPUT: output, ...env },
  });
  return { result, outputs: readOutputs(output) };
}

// Builds a git repository in dir whose commit messages run from the base
// commit to the head commit, and returns both full shas. A message is a
// string or an array of paragraphs, as git commit -m joins them.
function buildTrailerRepo(dir, messages) {
  const run = (...args) => {
    const created = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    if (created.status !== 0) throw new Error(`git ${args.join(' ')}: ${created.stderr}`);
    return created.stdout;
  };
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  for (const message of messages) {
    const args = ['commit', '-q', '--allow-empty'];
    for (const paragraph of Array.isArray(message) ? message : [message]) {
      args.push('-m', paragraph);
    }
    run(...args);
  }
  return {
    baseSha: messages.length > 1 ? run('rev-parse', `HEAD~${messages.length - 1}`).trim() : run('rev-parse', 'HEAD').trim(),
    headSha: run('rev-parse', 'HEAD').trim(),
  };
}

test('the public workflow starts the gate for the required pull request events and passes named secrets', () => {
  expect(frontdoor.on.pull_request.types).toEqual(fixture.pull_request_types);
  expect(frontdoor.jobs.gate.with.runner_label).toContain("&& 'review' || 'ubuntu-latest'");
  expect(Object.keys(frontdoor.jobs.gate.secrets).sort()).toEqual([...fixture.router_secrets, 'GH_APP_CLAUDE_BOT_PRIVATE_KEY', 'GITLEAKS_LICENSE_KEY', 'NTFY_BASE_URL'].sort());
});

test('the reusable workflow exposes router and check credentials to its caller', () => {
  const call = gate.on.workflow_call;
  expect(call.inputs.runner_label.default).toBe('ubuntu-24.04');
  expect(fixture.router_secrets.every((name) => call.secrets[name].required === false)).toBe(true);
  expect(call.secrets.NTFY_BASE_URL.required).toBe(false);
  expect(call.secrets.GH_APP_CLAUDE_BOT_PRIVATE_KEY.required).toBe(false);
});

test('the three policy reviews use dogfood rubrics, models, and blocking mode', () => {
  for (const { job, rubric, model } of fixture.review_jobs) {
    const review = gate.jobs[job];
    expect(review.uses).toBe('./.github/workflows/policy-gate.yml');
    expect(review.with).toMatchObject({ rubric, model, blocking: true });
    for (const name of [...fixture.router_secrets, 'NTFY_BASE_URL', 'GH_APP_CLAUDE_BOT_PRIVATE_KEY']) {
      expect(review.secrets[name]).toBe('$' + '{{ secrets.' + name + ' }}');
    }
  }
});

test('the code review is advisory and the final check does not wait for it', () => {
  const review = gate.jobs.code;
  expect(review.uses).toBe('./.github/workflows/policy-gate.yml');
  expect(review.with).toMatchObject({ rubric: 'code', model: 'standard', blocking: false });
  expect(review.if).toBe(gate.jobs.semantic.if);
  expect(review.secrets).toEqual(gate.jobs.semantic.secrets);
  expect(gate.jobs.gate.needs).not.toContain('code');
});

test('the leak reviews raise only their completion ceiling to 4000 tokens', () => {
  expect(gate.jobs.leak.with.max_tokens).toBe(4000);
  expect(gate.jobs.leak.with).toMatchObject({ model: 'standard', max_diff_kb: 150 });
  expect(gate.jobs.security.with.max_tokens).toBeUndefined();
  expect(gate.jobs.semantic.with.max_tokens).toBeUndefined();
  expect(workflow('dogfood-leak-review.yml').jobs['leak-review'].with).toMatchObject({
    model: 'standard', max_tokens: 4000, max_diff_kb: 150,
  });
});

test('the deterministic scan is pinned and checks out the full pull request head history', () => {
  const scan = gate.jobs.gitleaks;
  expect(scan.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
  const checkout = scan.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  expect(checkout.with).toMatchObject({
    ref: '${{ github.event.pull_request.head.sha }}',
    'fetch-depth': 0,
    'persist-credentials': false,
  });
  expect(scan.steps.some((step) => step.uses === 'gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e')).toBe(true);
});

test('the leak review runs on public repos only', () => {
  expect(gate.jobs.leak.if).toContain('!github.event.repository.private');
  expect(gate.jobs.gitleaks.if ?? '').not.toContain('private');
  expect(gate.jobs.gate.env.REPO_PRIVATE).toBe('$' + '{{ github.event.repository.private }}');
});

test('the gate reads commit trailers from a metadata-only pull request checkout', () => {
  const checkout = stepByName('Checkout the pull request head for commit metadata');
  expect(checkout.with).toMatchObject({
    ref: '${{ github.event.pull_request.head.sha || github.sha }}',
    'fetch-depth': 0,
    'persist-credentials': false,
  });
  const step = stepById('author-family');
  expect(step.run).toContain("git log --format='%(trailers:key=Assisted-by,valueonly)'");
  expect(step.run).toContain('$BASE_SHA..$HEAD_SHA');
  expect(step.env.FAMILIES_FILE).toBe('.ai-workflows/.github/scripts/policy-gate/model-families.json');
});

test('the reviewer family comes from the router responses, and the comparison lives in the validator', () => {
  expect(gate.jobs.gate.env.LEAK_MODEL).toBe('$' + '{{ needs.leak.outputs.reviewer_model }}');
  expect(gate.jobs.gate.env.SECURITY_MODEL).toBe('$' + '{{ needs.security.outputs.reviewer_model }}');
  expect(gate.jobs.gate.env.SEMANTIC_MODEL).toBe('$' + '{{ needs.semantic.outputs.reviewer_model }}');
  expect(stepById('verdict').run).toContain('RUBRIC=merge-gate');
  // The verdict step never maps or compares families itself; the validator
  // owns the comparison and reads the shared map.
  expect(stepById('verdict').run).not.toMatch(/family_of|FAMILIES_FILE/);
  const text = readFileSync(join('.github', 'workflows', '_ai-merge-gate.yml'), 'utf8');
  // No lane constants and no identity-derived family logic inline: the old
  // logic read the App slug and the bot login to name families.
  expect(text).not.toContain('MODEL_LANES');
  expect(text).not.toMatch(/REVIEWER_SLUG|PR_AUTHOR_TYPE|app-slug.*family/);
});

test('policy-gate publishes the model that wrote the review to its caller', () => {
  const outputs = policy.on.workflow_call.outputs;
  expect(outputs.reviewer_model.value).toBe('$' + '{{ jobs.review.outputs.reviewer_model }}');
  const review = policy.jobs.review;
  expect(review.outputs.reviewer_model).toBe('$' + '{{ steps.handoff.outputs.reviewer_model }}');
  const handoff = review.steps.find((step) => step.id === 'handoff');
  expect(handoff.env.RESPONSE_FILE).toBe('$' + '{{ steps.verdict.outputs.response-file }}');
  expect(handoff.run).toContain('.model');
  expect(handoff.run).toContain('reviewer_model=');
});

test('the verdict check run is published with the reviewer App token', () => {
  const mint = stepById('check-token');
  const policyMint = policy.jobs.gate.steps.find((step) => step.id === 'check-token');
  expect(mint.uses).toBe(policyMint.uses);
  expect(mint.with).toEqual(policyMint.with);
  expect(stepById('publish').env.GH_TOKEN).toBe('${{ steps.check-token.outputs.token }}');
  expect(stepById('publish').env.CHECK_APP_SLUG).toBe('${{ steps.check-token.outputs.app-slug }}');
});

test('the verdict aggregates every scan and review into MERGE, CHANGES, or DEFERRED', () => {
  const final = gate.jobs.gate;
  expect(final.needs).toEqual(fixture.required_jobs);
  expect(final.if).toBe('always()');
  expect(stepById('copilot').run).toContain('copilot');

  const conclusions = { MERGE: 'success', CHANGES: 'failure', DEFERRED: 'neutral' };
  for (const scenario of fixture.gate_scenarios) {
    const [gitleaks, leak, security, semantic] = scenario.results;
    const [leakModel, securityModel, semanticModel] = scenario.models;
    withGateWorkspace((dir) => {
      const { result, outputs } = runGateStep('verdict', dir, {
        IS_DRAFT: String(scenario.draft),
        REPO_PRIVATE: String(scenario.private ?? false),
        ROUTER_AVAILABLE: 'true',
        GITLEAKS_RESULT: gitleaks,
        LEAK_RESULT: leak,
        SECURITY_RESULT: security,
        SEMANTIC_RESULT: semantic,
        LEAK_MODEL: leakModel,
        SECURITY_MODEL: securityModel,
        SEMANTIC_MODEL: semanticModel,
        COPILOT_OUTCOME: 'success',
        COPILOT_FAILURES: scenario.copilot_failures ?? '0',
        AUTHOR_FAMILY: scenario.author_family ?? 'human',
        HEAD_SHA: 'b'.repeat(40),
      });
      expect(result.exitCode, `${scenario.name}: ${result.stderr.toString()}`).toBe(0);
      expect(outputs.verdict, scenario.name).toBe(scenario.verdict);
      expect(outputs.conclusion, scenario.name).toBe(conclusions[scenario.verdict]);
      if (scenario.reason_contains) {
        expect(outputs.reason, scenario.name).toContain(scenario.reason_contains);
      }
      const contract = JSON.parse(readFileSync(join(dir, 'ai-merge-gate.verdict.json'), 'utf8'));
      expect(contract, scenario.name).toEqual({
        model: scenario.model_line,
        author_family: scenario.author_family ?? 'human',
        head: 'b'.repeat(40),
        verdict: scenario.verdict,
      });

      const enforce = Bun.spawnSync(['/bin/bash', '-c', stepById('enforce').run], {
        cwd: dir,
        env: { ...process.env, GATE_VERDICT: outputs.verdict, GATE_REASON: outputs.reason },
      });
      expect(enforce.exitCode, scenario.name).toBe(scenario.exit_code);
    });
  }
});

test('the author family comes from the Assisted-by trailers of the commits in the change', () => {
  const FAMILIES_FILE = '.ai-workflows/.github/scripts/policy-gate/model-families.json';
  const cases = [
    {
      name: 'one agent-written commit maps its model',
      messages: ['chore: base', ['feat: add a helper', 'Assisted-by: Claude:claude-fable-5-2']],
      expected: 'anthropic',
    },
    {
      name: 'families from several commits join sorted',
      messages: [
        'docs: start',
        ['feat: agent one', 'Assisted-by: Claude:claude-fable-5-2'],
        ['feat: agent two', 'Assisted-by: Codex:gpt-5.5'],
      ],
      expected: 'anthropic+openai',
    },
    {
      name: 'no trailer anywhere is unknown',
      messages: ['fix: by hand', 'fix: by hand again'],
      expected: 'unknown',
    },
    {
      name: 'a provider-prefixed or upper-case model id still maps',
      messages: [
        'chore: base',
        ['feat: mixed', 'Assisted-by: Codex:OpenAI/GPT-5.5'],
        ['feat: more', 'Assisted-by: Claude:CLAUDE-SONNET-4-5'],
      ],
      expected: 'anthropic+openai',
    },
    {
      name: 'a trailer without a model id is ignored',
      messages: ['chore: base', ['feat: vague', 'Assisted-by: SomeAgentName']],
      expected: 'unknown',
    },
    {
      name: 'an unmappable model id is the unknown family',
      messages: ['chore: base', ['feat: mystery', 'Assisted-by: Claude:mystery-model-x']],
      expected: 'unknown',
    },
    {
      name: 'the base commit is outside the range',
      messages: [['chore: base', 'Assisted-by: Claude:claude-fable-5-2'], 'fix: clean head'],
      expected: 'unknown',
    },
  ];
  for (const { name, messages, expected } of cases) {
    withGateWorkspace((dir) => {
      expect(messages.length).toBeGreaterThan(1);
      const { baseSha, headSha } = buildTrailerRepo(dir, messages);
      const { result, outputs } = runGateStep('author-family', dir, {
        BASE_SHA: baseSha,
        HEAD_SHA: headSha,
        FAMILIES_FILE,
      });
      expect(result.exitCode, `${name}: ${result.stderr.toString()}`).toBe(0);
      expect(outputs.author_family, name).toBe(expected);
    });
  }
});

test('an unreadable commit range fails the author family step closed', () => {
  withGateWorkspace((dir) => {
    buildTrailerRepo(dir, ['chore: base', 'fix: head']);
    const { result } = runGateStep('author-family', dir, {
      BASE_SHA: 'd'.repeat(40),
      HEAD_SHA: 'b'.repeat(40),
      FAMILIES_FILE: '.ai-workflows/.github/scripts/policy-gate/model-families.json',
    });
    // The ::error annotation goes to the step log; git's own failure to stderr.
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain('Could not read the pull request commits');
    expect(result.stderr.toString()).toContain('fatal:');
  });
});

test('the published summary prepends the rubric line and carries the four contract lines in order', () => {
  const contractLines = (summary) => summary.split('\n').filter((line) => /^(model|author_family|head|VERDICT):/.test(line));

  const capture = (reason, token = 'app-token') =>
    withGateWorkspace((dir) => {
      const helperDir = join(dir, '.ai-workflows', '.github', 'scripts', 'shared');
      mkdirSync(helperDir, { recursive: true });
      const captured = join(dir, 'captured');
      const summaryArg = join(dir, 'captured-summary');
      writeFileSync(
        join(helperDir, 'check-run.sh'),
        [
          '#!/bin/sh',
          `printf '%s\\n' "$1" "$2" "$3" "$4" > '${captured}'`,
          `printf '%s' "$5" > '${summaryArg}'`,
          '',
        ].join('\n'),
      );
      chmodSync(join(helperDir, 'check-run.sh'), 0o755);
      writeFileSync(join(dir, 'ai-merge-gate.verdict.json'), JSON.stringify({
        model: 'claude-opus-5-5',
        author_family: 'human',
        head: 'b'.repeat(40),
        verdict: 'MERGE',
      }));
      const result = Bun.spawnSync(['/bin/bash', '-c', stepById('publish').run], {
        cwd: dir,
        env: {
          ...process.env,
          GH_TOKEN: token,
          CHECK_APP_SLUG: 'jpe-claude-bot',
          CHECK_HEAD_SHA: 'b'.repeat(40),
          GATE_CONCLUSION: 'success',
          GATE_REASON: reason,
          VERDICT_FILE: 'ai-merge-gate.verdict.json',
          SUMMARY_FILE: 'ai-merge-gate.summary.md',
          RUBRIC_LINE: fixture.rubric_line,
        },
      });
      return {
        result,
        invoked: existsSync(captured) ? readFileSync(captured, 'utf8').trim().split('\n') : null,
        summary: existsSync(summaryArg) ? readFileSync(summaryArg, 'utf8') : null,
      };
    });

  const published = capture('');
  expect(published.result.exitCode, published.result.stderr.toString()).toBe(0);
  expect(published.invoked).toEqual(['upsert', 'AI Merge Gate', 'success', 'AI Merge Gate']);
  // $(cat ...) strips the trailing newline, so the API receives the summary
  // without one. Exactly four contract lines, in order, nothing between them.
  expect(published.summary).toBe(
    [
      fixture.rubric_line,
      '',
      'model: claude-opus-5-5',
      'author_family: human',
      `head: ${'b'.repeat(40)}`,
      'VERDICT: MERGE',
    ].join('\n'),
  );
  expect(contractLines(published.summary)).toEqual([
    'model: claude-opus-5-5',
    'author_family: human',
    `head: ${'b'.repeat(40)}`,
    'VERDICT: MERGE',
  ]);

  // On a refusal the reason is the last summary line before VERDICT, and the
  // four contract lines keep their order around it.
  const refused = capture('reviewer and author share the family anthropic');
  expect(refused.result.exitCode).toBe(0);
  const refusedLines = refused.summary.split('\n');
  expect(refusedLines.at(-1)).toBe('VERDICT: MERGE');
  expect(refusedLines.at(-2)).toBe('reason: reviewer and author share the family anthropic');
  expect(contractLines(refused.summary)).toEqual([
    'model: claude-opus-5-5',
    'author_family: human',
    `head: ${'b'.repeat(40)}`,
    'VERDICT: MERGE',
  ]);

  const untokened = capture('', '');
  expect(untokened.result.exitCode).toBe(0);
  expect(untokened.result.stdout.toString()).toContain('cannot publish the verdict check run');
  expect(untokened.invoked).toBeNull();
});

test('the contract shape fails when a summary line is missing', () => {
  // The four contract lines must all be present and exactly once; dropping
  // the head line leaves three and the shape assertion above would fail.
  const contractLines = (summary) => summary.split('\n').filter((line) => /^(model|author_family|head|VERDICT):/.test(line));
  const valid = ['model: a', 'author_family: human', `head: ${'b'.repeat(40)}`, 'VERDICT: MERGE'];
  expect(contractLines(valid.join('\n'))).toHaveLength(4);
  expect(contractLines(valid.filter((line) => !line.startsWith('head:')).join('\n'))).toHaveLength(3);
  expect(contractLines(valid.concat(['model: a']).join('\n'))).toHaveLength(5);
});
