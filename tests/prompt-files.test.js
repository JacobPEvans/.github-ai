const { expect, test } = require('bun:test');
const { readFileSync, readdirSync } = require('fs');
const { join } = require('path');

// Every .prompt.yml in the catalog is what actions/ai-inference loads:
// a messages array, a JSON schema when it asks for one, and no model (the
// workflow's `model` input, a router role alias, supplies it). Each {{var}}
// must be one the calling workflow maps in `file_input`.
const catalog = join('.ai-llm-prompts', 'automation');
const prompts = readdirSync(catalog)
  .filter((f) => f.startsWith('ai-workflows-') && f.endsWith('.prompt.yml'))
  .map((f) => join(catalog, f));

test('workflow prompts live only in the catalog', () => {
  const localPrompts = readdirSync(join('.github', 'scripts'), { recursive: true })
    .filter((file) => file.endsWith('.prompt.yml'));
  expect(localPrompts).toEqual([]);
});

const workflows = readdirSync(join('.github', 'workflows'))
  .map((f) => readFileSync(join('.github', 'workflows', f), 'utf8'))
  .join('\n');

test('at least one prompt file exists', () => {
  expect(prompts.length).toBeGreaterThan(0);
});

for (const file of prompts) {
  test(`${file} is a valid ai-inference prompt whose variables the workflow supplies`, () => {
    const text = readFileSync(file, 'utf8');
    const config = Bun.YAML.parse(text);
    expect(Array.isArray(config.messages)).toBe(true);
    expect(config.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(config.model).toBeUndefined();
    if (config.responseFormat) {
      expect(config.responseFormat).toBe('json_schema');
      const schema = JSON.parse(config.jsonSchema);
      expect(schema.strict).toBe(true);
      expect(schema.schema.type).toBe('object');
    }
    // A rubric prompt is selected by the review name in the workflow.
    const literal = `prompt-file: ${file}`;
    const selected = workflows.includes(literal) ? literal : 'prompt-file: .ai-llm-prompts/automation/ai-workflows-${{';
    expect(workflows.includes(selected)).toBe(true);
    const use = workflows.slice(workflows.indexOf(selected));
    expect(use.length).toBeGreaterThan(0);
    const mapped = use.slice(0, use.indexOf('custom-headers')).match(/^\s+([a-z]+): [^\n]+$/gm).map((l) => l.trim().split(':')[0]);
    for (const [, name] of text.matchAll(/\{\{([\w.-]+)\}\}/g)) {
      expect(mapped).toContain(name);
    }
  });
}

for (const name of readdirSync(join('.github', 'workflows'))) {
  const config = Bun.YAML.parse(readFileSync(join('.github', 'workflows', name), 'utf8'));
  for (const [jobName, job] of Object.entries(config.jobs ?? {})) {
    const steps = job.steps ?? [];
    for (const [index, step] of steps.entries()) {
      if (!step.with?.['prompt-file']?.startsWith('.ai-llm-prompts/')) continue;
      test(`${name}: ${jobName} checks out the inference prompt before reading it`, () => {
        const checkoutIndex = steps.findIndex((s) => s.uses === './.ai-workflows/.github/actions/checkout-prompts');
        expect(checkoutIndex).toBeGreaterThanOrEqual(0);
        expect(checkoutIndex).toBeLessThan(index);
        expect(steps[checkoutIndex].with['sparse-checkout']).toBe(step.with['prompt-file'].replace('.ai-llm-prompts/', ''));
        const scriptsCheckout = steps.find((s) => s.with?.path === '.ai-workflows');
        expect(scriptsCheckout.with['sparse-checkout']).toContain('.github/actions/checkout-prompts');
      });
    }
  }
}
