'use strict';

const { isTrustedAuthorAssociation } = require('./authors');

function resolveIssueNumber(inputIssueNumber, eventIssueNumber) {
  const input = String(inputIssueNumber ?? '').trim();
  if (input !== '') {
    if (!/^\d+$/.test(input)) return null;
    const parsedInput = Number(input);
    if (!Number.isSafeInteger(parsedInput)) return null;
    if (parsedInput !== 0) return parsedInput;
  }

  const parsedEvent = Number(eventIssueNumber);
  return Number.isSafeInteger(parsedEvent) && parsedEvent > 0 ? parsedEvent : null;
}

async function checkIssueAuthor({ github, context, core, inputIssueNumber }) {
  let trusted = false;

  try {
    const issueNumber = resolveIssueNumber(inputIssueNumber, context.payload?.issue?.number);
    if (!issueNumber || !context.repo?.owner || !context.repo?.repo) {
      throw new Error('Missing or invalid issue reference.');
    }

    const { data: issue } = await github.rest.issues.get({
      ...context.repo,
      issue_number: issueNumber,
    });
    trusted = isTrustedAuthorAssociation(issue?.author_association)
      && (!context.payload?.comment
        || isTrustedAuthorAssociation(context.payload.comment.author_association));
  } catch {
    core.warning?.('Issue author could not be verified; triage will be skipped.');
  }

  core.setOutput('trusted', trusted ? 'true' : 'false');
  return trusted;
}

module.exports = { checkIssueAuthor, resolveIssueNumber };
