const { expect, test } = require('bun:test');
const { readFileSync } = require('fs');

// cc-ci-fix is started by its callers: from a failed gate run or from the
// ci-fix label. The gates here keep legacy callers
// intact, restrict hot-tier repositories to merge-group failures + the label,
// serialize PR writers, and skip queued PRs before any push.
const ciFix = Bun.YAML.parse(readFileSync('.github/workflows/cc-ci-fix.yml', 'utf8'));
const events = ciFix.on ?? ciFix[true];
const jobs = ciFix.jobs;
const CONCLUSION_GATE = "(inputs.failure_conclusion || github.event.workflow_run.conclusion) == 'failure'";
const LABEL_GATE = "github.event_name == 'pull_request' && github.event.label.name == 'ci-fix'";
const TIER_GATE = "(github.event.repository.custom_properties.merge_tier || 'legacy') != 'hot'";
const MERGE_GROUP_GATE = "github.event.workflow_run.event == 'merge_group'";
const WRITER_GROUP = 'pr-writer-${{ github.repository }}-${{ needs.should-fix.outputs.pr_number }}';
const PR_HEAD_REF = '${{ inputs.failure_head_branch || github.event.workflow_run.head_branch || github.event.pull_request.head.ref }}';
const stepByName = (job, name) => jobs[job].steps.find((step) => step.name === name);

test('the reusable workflow has no pull request or workflow_run trigger of its own', () => {
  expect(events.workflow_call.secrets.LLM_ROUTER_BASE_URL).toBeDefined();
  expect(events.workflow_dispatch).toBeDefined();
  expect(events.workflow_run).toBeUndefined();
  expect(events.pull_request).toBeUndefined();
});

test('one run per branch at a time, never cancelled', () => {
  expect(ciFix.concurrency.group).toContain('ci-fix-${{ github.repository }}-');
  expect(ciFix.concurrency.group).toContain('github.event.pull_request.head.ref');
  expect(ciFix.concurrency['cancel-in-progress']).toBe(false);
});

test('the writing jobs share the per-PR writer group', () => {
  for (const name of ['post-attempt-comment', 'publish', 'notify-failure']) {
    expect(jobs[name].concurrency.group, name).toBe(WRITER_GROUP);
    expect(jobs[name].concurrency['cancel-in-progress'], name).toBe(false);
  }
  for (const name of ['should-fix', 'check-daily-limit', 'get-failure-details', 'fix']) {
    expect(jobs[name].concurrency, name).toBeUndefined();
  }
});

test('legacy and standard repositories keep the conclusion gate', () => {
  expect(jobs['should-fix'].if).toContain(CONCLUSION_GATE);
  expect(jobs['check-daily-limit'].if).toContain(CONCLUSION_GATE);
});

test('the ci-fix label bypasses the conclusion gate', () => {
  expect(jobs['should-fix'].if).toContain(LABEL_GATE);
  expect(jobs['check-daily-limit'].if).toContain(LABEL_GATE);
});

test('hot repositories only act on merge_group failures or the label', () => {
  for (const name of ['should-fix', 'check-daily-limit']) {
    expect(jobs[name].if, name).toContain(TIER_GATE);
    expect(jobs[name].if, name).toContain(MERGE_GROUP_GATE);
    expect(jobs[name].if, name).toContain(LABEL_GATE);
  }
});

test('fork guards accept same-repository pull requests and keep refusing forks', () => {
  const guard =
    '(github.event.workflow_run.head_repository.full_name || inputs.failure_head_repository || ' +
    'github.event.pull_request.head.repo.full_name) == github.repository';
  for (const name of ['post-attempt-comment', 'get-failure-details', 'fix']) {
    expect(jobs[name].if, name).toContain(guard);
  }
});

test('the 2-attempt bound stays wired into should-fix', () => {
  expect(jobs['should-fix'].steps.some((step) => step.id === 'check-attempts')).toBe(true);
  expect(jobs['should-fix'].outputs.pr_number).toBe('${{ steps.find-pr.outputs.pr_number }}');
});

test('the label path resolves the PR, the branch, and the failure run', () => {
  expect(stepByName('should-fix', 'Find associated PR').env.FAILURE_HEAD_BRANCH).toBe(PR_HEAD_REF);
  expect(stepByName('get-failure-details', 'Download failure logs').env.FAILURE_HEAD_BRANCH).toBe(PR_HEAD_REF);
  expect(stepByName('fix', 'Checkout PR branch').with.ref).toBe(PR_HEAD_REF);
  expect(stepByName('publish', 'Checkout PR branch').with.ref).toBe(PR_HEAD_REF);
});

test('the publisher skips queued PRs before any push', () => {
  const commit = stepByName('publish', 'Commit fix to PR branch');
  expect(commit.env.HEAD_BRANCH).toBe(PR_HEAD_REF);
  expect(commit.env.PR_NUMBER).toBe('${{ needs.should-fix.outputs.pr_number }}');
  const mint = stepByName('publish', 'Mint commit token');
  expect(mint.with['permission-pull-requests']).toBe('read');
});

test('labeled runs keep the full job window while caller PR events stay short', () => {
  for (const job of Object.values(jobs)) {
    expect(job['timeout-minutes']).toBe(
      "${{ github.event_name == 'pull_request' && github.event.action != 'labeled' && 5 || 30 }}",
    );
  }
});
