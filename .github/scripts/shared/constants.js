// Shared constants for ai-workflows scripts

// Dependency update bots.
const dependencyBots = ['renovate[bot]', 'dependabot[bot]'];

// The release-please bot that opens release pull requests.
const RELEASE_BOT = 'jacobpevans-release-please[bot]';

// Bots whose commits/PRs should be skipped by automation workflows.
// Includes dependency bots (renovate, dependabot) and AI bots (claude).
const automationBots = [...dependencyBots, 'claude[bot]'];

// Pull request authors whose changes no model wrote: AI Review and
// verdict/merge pass them without a model. ai-review.yml repeats this list in
// job conditions; tests/bot-lists.test.js keeps them equal.
const noModelBots = ['renovate[bot]', RELEASE_BOT];

// Daily ceiling for bot-created PRs (prevents automation loops).
// Configurable per-workflow via PR_DAILY_CEILING env var in check-pr-ceiling.js.
const PR_DAILY_CEILING = 5;

// Daily ceiling for bot-created issues (prevents automation loops).
const ISSUE_DAILY_CEILING = 5;

module.exports = { dependencyBots, RELEASE_BOT, automationBots, noModelBots, PR_DAILY_CEILING, ISSUE_DAILY_CEILING };
