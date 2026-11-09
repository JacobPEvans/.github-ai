'use strict';

const TRUSTED_AUTHOR_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);

function isTrustedAuthorAssociation(authorAssociation) {
  return typeof authorAssociation === 'string'
    && TRUSTED_AUTHOR_ASSOCIATIONS.includes(authorAssociation.toUpperCase());
}

function filterTrustedIssues(records) {
  if (!Array.isArray(records)) throw new TypeError('GitHub did not return an issue list.');

  const issues = records.filter(record => !record.pull_request);
  if (issues.some(issue => typeof issue.author_association !== 'string' || !issue.author_association)) {
    throw new Error('GitHub issue response omitted author_association; issue text is blocked.');
  }

  const trusted = issues.filter(issue => isTrustedAuthorAssociation(issue.author_association));
  return { trusted, skipped: issues.length - trusted.length };
}

function filterTrustedComments(records) {
  if (!Array.isArray(records)) throw new TypeError('GitHub did not return a comment list.');

  const trusted = records.filter(comment => isTrustedAuthorAssociation(comment.author_association));
  return { trusted, skipped: records.length - trusted.length };
}

module.exports = {
  TRUSTED_AUTHOR_ASSOCIATIONS,
  filterTrustedComments,
  filterTrustedIssues,
  isTrustedAuthorAssociation,
};
