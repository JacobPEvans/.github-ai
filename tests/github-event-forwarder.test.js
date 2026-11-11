const { expect, test } = require('bun:test');
const { readFileSync } = require('fs');
const { spawnSync } = require('child_process');

const workflow = Bun.YAML.parse(readFileSync('.github/workflows/github-event-forwarder.yml', 'utf8'));
const caller = Bun.YAML.parse(readFileSync('.github/workflows/dogfood-github-event-forwarder.yml', 'utf8'));
const step = workflow.jobs.forward.steps[0];

function forward(event, overrides = {}) {
  return spawnSync('bash', ['-c', `curl() { printf '%s\\0' "$@"; return "\${CURL_EXIT_CODE:-0}"; }\n${step.run}`], {
    input: typeof event === 'string' ? event : JSON.stringify(event),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      AGENT_NAME: 'ci-fixer',
      WEBHOOK_URL: 'https://example.test/webhook',
      GITHUB_EVENT_PATH: '/dev/stdin',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_RUN_ID: '123',
      GITHUB_REPOSITORY: 'example/repo',
      GITHUB_SHA: 'merge-sha',
      GITHUB_ACTOR: 'example-bot',
      ...overrides,
    },
  });
}

const repo = { html_url: 'https://github.com/example/repo' };
for (const [name, event, eventName, subject, revision, type] of [
  ['pull request', { action: 'opened', repository: repo, pull_request: { html_url: `${repo.html_url}/pull/7`, head: { sha: 'pr-head' }, body: '$(exit 99) " untrusted' } }, 'pull_request', `${repo.html_url}/pull/7`, 'pr-head', 'pull_request.opened'],
  ['check run', { action: 'completed', repository: repo, check_run: { html_url: `${repo.html_url}/runs/9`, head_sha: 'check-head' } }, 'check_run', `${repo.html_url}/runs/9`, 'check-head', 'check_run.completed'],
  ['repository', { repository: repo }, 'push', repo.html_url, 'merge-sha', 'push'],
]) {
  test(`forwards a compact ${name} envelope`, () => {
    const result = forward(event, { GITHUB_EVENT_NAME: eventName });
    expect(result.status).toBe(0);
    const args = result.stdout.split('\0');
    const data = args[args.indexOf('--data') + 1];
    const envelope = JSON.parse(data);
    expect(envelope).toEqual({
      id: '123', source: 'github', type, agent: 'ci-fixer', subject, revision,
      actor: 'example-bot', time: expect.any(String), correlation_id: 'example/repo/123',
    });
    expect(data).toBe(JSON.stringify(envelope));
    expect(envelope.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(args).toContain('--fail');
    expect(args[args.indexOf('--proto') + 1]).toBe('=https');
    expect(args[args.indexOf('--max-time') + 1]).toBe('60');
    expect(args[args.indexOf('--output') + 1]).toBe('/dev/null');
    expect(args).toContain('Content-Type: application/json');
    expect(args.at(-2)).toBe('https://example.test/webhook');
  });
}

test('missing configuration and invalid JSON fail before HTTP delivery', () => {
  for (const result of [forward({}, { WEBHOOK_URL: '' }), forward({}, { AGENT_NAME: '' }), forward('{')]) {
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  }
});

test('HTTP failure fails the forwarding step', () => {
  expect(forward({ repository: repo }, { CURL_EXIT_CODE: '22' }).status).toBe(22);
});

test('reruns preserve delivery and correlation identifiers', () => {
  const readEnvelope = (result) => {
    const args = result.stdout.split('\0');
    return JSON.parse(args[args.indexOf('--data') + 1]);
  };
  const first = readEnvelope(forward({ repository: repo }));
  const second = readEnvelope(forward({ repository: repo }, { GITHUB_RUN_ATTEMPT: '2' }));
  expect(second.id).toBe(first.id);
  expect(second.correlation_id).toBe(first.correlation_id);
});

test('workflow reads the explicit secret or the inherited one, with no token permissions or checkout', () => {
  expect(workflow.permissions).toEqual({});
  expect(workflow.on.workflow_call.inputs.runner_label.default).toBe('self-hosted');
  expect(step.env.WEBHOOK_URL).toBe('${{ secrets.webhook_url || secrets[inputs.webhook_url_secret_name] }}');
  expect(workflow.jobs.forward.steps).toHaveLength(1);
  expect(step.uses).toBeUndefined();
});

test('dogfood calls the local workflow for both triggers with opt-in and fork guards', () => {
  expect(caller.on.pull_request.types).toContain('opened');
  expect(caller.on.check_run.types).toEqual(['completed']);
  expect(caller.jobs.forward.uses).toBe('./.github/workflows/github-event-forwarder.yml');
  expect(caller.jobs.forward.secrets).toEqual({ webhook_url: '${{ secrets.DIFY_CI_FIXER_WEBHOOK_URL }}' });
  expect(caller.jobs.forward.if).toContain("vars.DOGFOOD_SELF_HOSTED == 'true'");
  expect(caller.jobs.forward.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
});
