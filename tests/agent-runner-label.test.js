const { expect, test } = require('bun:test');
const { readFileSync, readdirSync } = require('fs');

const dir = '.github/workflows';
const agentJobs = readdirSync(dir)
  .filter((file) => file.endsWith('.yml'))
  .flatMap((file) => {
    const workflow = Bun.YAML.parse(readFileSync(`${dir}/${file}`, 'utf8'));
    return Object.entries(workflow.jobs || {})
      .filter(([, job]) => (job.steps || []).some((step) => (step.uses || '').endsWith('/actions/run-ai-agent')))
      .map(([name, job]) => ({ id: `${file}:${name}`, runsOn: String(job['runs-on']) }));
  });

test('every job that runs the agent action is found', () => {
  expect(agentJobs.length).toBe(17);
});

test.each(agentJobs.map((job) => [job.id, job.runsOn]))(
  '%s runs only on review or a GitHub-hosted ubuntu label',
  (_id, runsOn) => {
    expect(runsOn).toMatch(/startsWith\(inputs\.(review_)?runner_label[^,]*, 'ubuntu-'\)/);
    expect(runsOn).toContain("|| 'review'");
    expect(runsOn).not.toContain('self-hosted');
  },
);
