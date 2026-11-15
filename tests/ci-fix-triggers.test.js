const { readFileSync } = require('fs');

// cc-ci-fix is started by its callers: from a failed gate run or from the
// ci-fix label. The gates here keep legacy callers
// intact, restrict hot-tier repositories to merge-group failures + the label,
// serialize PR writers, and skip queued PRs before any push.
const ciFix = Bun.YAML.parse(readFileSync('.github/workflows/cc-ci-fix.yml', 'utf8'));
const events = ciFix.on ?? ciFix[true];
const jobs = ciFix.jobs;
const CONCLUSION_GATE = "(inputs.failure_conclusion || github.event.workflow_run.conclusion) == 'failure'";
const LABEL_GATE = "github.event_name == 'pull_request' && github.event.action == 'labeled' && github.event.label.name == 'ci-fix'";
const TIER_GATE = "(github.event.repository.custom_properties.merge_tier || 'legacy') != 'hot'";
const HOT_TIER_GATE = "(github.event.repository.custom_properties.merge_tier || 'legacy') == 'hot'";
const MERGE_GROUP_GATE = "github.event.workflow_run.event == 'merge_group'";
const BOT_GATES = ['renovate[bot]', 'dependabot[bot]', 'copilot[bot]'].map((bot) => `(inputs.failure_actor || github.actor) != '${bot}'`);
// Non-hot reduces to the old conclusion gate; hot adds merge_group failures or
// the labeled ci-fix request. The label disjunct is guarded by the hot tier.
const FIX_GATE = `((${TIER_GATE} || ${MERGE_GROUP_GATE}) && ${CONCLUSION_GATE} || ${HOT_TIER_GATE} && ${LABEL_GATE}) && ${BOT_GATES.join(' && ')}`;
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
  expect(stepByName('fix', 'Checkout PR branch').with.ref).toBe('${{ needs.should-fix.outputs.head_branch }}');
  expect(stepByName('publish', 'Checkout PR branch').with.ref).toBe('${{ needs.should-fix.outputs.head_branch }}');
});

test('the publisher skips queued PRs before any push', () => {
  const commit = stepByName('publish', 'Commit fix to PR branch');
  expect(commit.env.HEAD_BRANCH).toBe('${{ needs.should-fix.outputs.head_branch }}');
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

// Findings 1-2: pin the whole gate, not substrings. Outside hot the label
// disjunct is dead (hot tier guard) and the conclusion gate stands alone; the
// label path additionally requires action labeled, so unlabeled never passes.
test('the fix gate is exactly tier-gated with a labeled-only hot label path', () => {
  for (const name of ['should-fix', 'check-daily-limit']) {
    expect(jobs[name].if, name).toBe(FIX_GATE);
  }
});

const commitScript = stepByName('publish', 'Commit fix to PR branch').with.script;

test('the fix and publish jobs work on the branch the pull request lookup resolved', () => {
  expect(jobs['should-fix'].outputs.head_branch).toBe('${{ steps.find-pr.outputs.head_branch }}');
  const resolved = '${{ needs.should-fix.outputs.head_branch }}';
  expect(stepByName('publish', 'Commit fix to PR branch').env.HEAD_BRANCH).toBe(resolved);
  for (const name of ['fix', 'publish']) {
    const refs = jobs[name].steps.filter((step) => step.with && step.with.ref).map((step) => step.with.ref);
    expect(refs, name).toContain(resolved);
    expect(refs.join(' '), name).not.toContain('workflow_run.head_branch');
  }
});

test('the commit step keeps the App token and the queued-PR skip for other paths', () => {
  const commit = stepByName('publish', 'Commit fix to PR branch');
  expect(commit.with['github-token']).toBe('${{ steps.commit-token.outputs.token }}');
  expect(commit.env.PR_NUMBER).toBe('${{ needs.should-fix.outputs.pr_number }}');
  expect(commitScript).toContain("require('./.ai-workflows/.github/scripts/ci-fix/commit-fix.js')");
});

// Finding 4: drive the real script with a stubbed Actions client. The newest
// failed run is the fixer's own; the fallback must skip it and prefer CI Gate.
const getFailureLogs = require('../.github/scripts/ci-fix/get-failure-logs.js');
const FIXER_RUN = { id: 1, name: 'CI Fix', workflow_id: 900 };
const GATE_RUN = { id: 2, name: 'CI Gate', workflow_id: 100 };
const LINT_RUN = { id: 3, name: 'Lint', workflow_id: 200 };

async function runGetLogs({ env = {}, runs = [] } = {}) {
  const listCalls = [];
  const jobCalls = [];
  let failed = null;
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: { workflow_id: 900 } }),
        listWorkflowRunsForRepo: async (params) => {
          listCalls.push(params);
          return { data: { workflow_runs: runs } };
        },
        listJobsForWorkflowRun: async () => ({}),
        downloadJobLogsForWorkflowRun: async () => ({ data: 'log line' }),
      },
    },
    paginate: async (fn, params) => {
      jobCalls.push(params);
      return [{ id: 5, name: 'gate', conclusion: 'failure' }];
    },
  };
  const context = { repo: { owner: 'o', repo: 'r' }, runId: 123, payload: {} };
  const core = { setFailed: (m) => { failed = m; }, info: () => {}, setOutput: () => {} };
  const keys = ['FAILURE_RUN_ID', 'FAILURE_HEAD_BRANCH', 'FAILURE_HEAD_SHA'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { FAILURE_RUN_ID: '', FAILURE_HEAD_BRANCH: 'feature', FAILURE_HEAD_SHA: 'c'.repeat(40) }, env);
  try {
    await getFailureLogs({ github, context, core });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { listCalls, jobCalls, failed };
}

test('the label fallback prefers a CI Gate run on the head sha, never the fixer', async () => {
  const { listCalls, jobCalls, failed } = await runGetLogs({ runs: [FIXER_RUN, LINT_RUN, GATE_RUN] });
  expect(failed).toBeNull();
  expect(listCalls[0].head_sha).toBe('c'.repeat(40));
  expect(listCalls[0].status).toBe('failure');
  expect(jobCalls[0].run_id).toBe(GATE_RUN.id);
});

test('the label fallback takes the newest non-fixer run when no CI Gate exists', async () => {
  const { jobCalls, failed } = await runGetLogs({ runs: [FIXER_RUN, LINT_RUN] });
  expect(failed).toBeNull();
  expect(jobCalls[0].run_id).toBe(LINT_RUN.id);
});

test('the label fallback fails closed when only the fixer has failed runs', async () => {
  const { jobCalls, failed } = await runGetLogs({ runs: [FIXER_RUN] });
  expect(failed).toContain('No failed CI run');
  expect(jobCalls).toEqual([]);
});

test('an explicit failure run id skips the fallback entirely', async () => {
  const { listCalls, jobCalls } = await runGetLogs({ env: { FAILURE_RUN_ID: '55' }, runs: [FIXER_RUN] });
  expect(listCalls).toEqual([]);
  expect(String(jobCalls[0].run_id)).toBe('55');
});

test('the failure-log step passes the PR head sha for the label fallback', () => {
  expect(stepByName('get-failure-details', 'Download failure logs').env.FAILURE_HEAD_SHA).toBe('${{ github.event.pull_request.head.sha }}');
});

// Finding 5: notify-failure must not run (and share an empty writer lock) when
// the PR number is unknown.
test('notify-failure only runs when the PR number is known', () => {
  expect(jobs['notify-failure'].if).toBe("failure() && !inputs.dry_run && needs.should-fix.outputs.pr_number != ''");
});
