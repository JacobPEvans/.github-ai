const { expect, test } = require('bun:test');
const { readFileSync } = require('fs');
const { ceilingOf } = require('../.github/scripts/permission-ceiling/ceiling.js');

const workflow = (name) => Bun.YAML.parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));
const callers = [
  ['ai-review', 'scope', 'scope-classify'],
  ['dogfood-best-practices', 'best-practices', 'best-practices'],
  ['dogfood-ci', 'ci-suite', 'suite-ci'],
  ['dogfood-code-simplifier', 'simplify', 'cc-code-simplifier'],
  ['dogfood-issue-hygiene', 'hygiene', 'issue-hygiene'],
  ['dogfood-issue-sweeper', 'sweep', 'issue-sweeper'],
];

for (const [name, jobName, reusableName] of callers) {
  test(`${name} forwards the reusable workflow contract`, () => {
    const caller = workflow(name);
    const job = caller.jobs[jobName];
    const reusable = workflow(reusableName);
    const call = reusable.on.workflow_call;
    expect(job.uses).toBe(`JacobPEvans/.github-ai/.github/workflows/${reusableName}.yml@v2`);
    expect(job.permissions ?? caller.permissions).toEqual(ceilingOf(reusableName, reusable));
    if (call.inputs?.runner_label) {
      expect(job.with.runner_label).toBe('review');
    }
    if (call.secrets) {
      expect(Object.keys(job.secrets).sort()).toEqual(Object.keys(call.secrets).sort());
      for (const secret of Object.keys(call.secrets)) {
        expect(job.secrets[secret]).toBe('$' + '{{ secrets.' + secret + ' }}');
      }
    } else {
      expect(job.secrets).toBe('inherit');
      expect(readFileSync(`.github/workflows/${reusableName}.yml`, 'utf8')).toContain('secrets.LLM_ROUTER_API_KEY');
    }
  });
}
