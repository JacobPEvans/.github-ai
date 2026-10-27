const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const postStickyComment = require('../shared/sticky-comment.js');

const EVALS_REPOSITORY = 'https://github.com/dryvist/llm-prompt-evals.git';
const DEFAULT_ALLOWED_PATHS = 'prompts/**,skills/**';

function labelNames(labels) {
  return (labels || [])
    .map((label) => (typeof label === 'string' ? label : label && label.name))
    .filter((name) => typeof name === 'string');
}

function datasetLabel(labels) {
  const matches = labelNames(labels).filter((name) => name.startsWith('dataset:'));
  if (matches.length !== 1) {
    return { dataset: null, reason: 'proposal must have exactly one dataset:<name> label' };
  }
  const dataset = matches[0].slice('dataset:'.length).trim();
  if (!dataset || /-(train|holdout)$/i.test(dataset)) {
    return { dataset: null, reason: 'dataset label must name an unsuffixed dataset' };
  }
  return { dataset, reason: null };
}

function matchesGlob(filePath, pattern) {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/');
  const normalizedPattern = String(pattern || '').replace(/\\/g, '/');
  let expression = '^';
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    if (character === '*') {
      if (normalizedPattern[index + 1] === '*') {
        if (normalizedPattern[index + 2] === '/') {
          expression += '(?:.*/)?';
          index += 2;
        } else {
          expression += '.*';
          index += 1;
        }
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      if ('\\^$+?.()|{}[]'.includes(character)) expression += '\\';
      expression += character;
    }
  }
  return new RegExp(expression + '$').test(normalizedPath);
}

function isForcedReviewPath(filePath) {
  const segments = String(filePath || '').replace(/\\/g, '/').split('/');
  return segments[0] === 'rules' ||
    segments[0] === '.github' ||
    segments.some((segment) => segment.toLowerCase() === 'security');
}

function isPromptOrSkillPath(filePath) {
  const segments = String(filePath || '').replace(/\\/g, '/').split('/');
  return segments.slice(0, -1).some((segment) => segment === 'prompts' || segment === 'skills');
}

function allowedPatterns(value) {
  return (Array.isArray(value) ? value : String(value || DEFAULT_ALLOWED_PATHS).split(','))
    .map((pattern) => String(pattern).trim())
    .filter(Boolean);
}

function assessProposal({ labels, files, allowedPaths, initialHeadSha, currentHeadSha }) {
  const reasons = [];
  const selectedDataset = datasetLabel(labels);
  if (selectedDataset.reason) reasons.push(selectedDataset.reason);
  if (!Array.isArray(files) || files.length === 0) reasons.push('proposal has no changed files');
  const patterns = allowedPatterns(allowedPaths);
  for (const file of files || []) {
    const filename = file && file.filename;
    if (!filename) {
      reasons.push('changed path could not be identified');
      continue;
    }
    if (file.status !== 'modified') reasons.push('added, deleted, or renamed files require review');
    if (isForcedReviewPath(filename)) reasons.push('protected paths require human review');
    if (!patterns.some((pattern) => matchesGlob(filename, pattern))) {
      reasons.push('changed path is outside the allowlist');
    }
    if (!isPromptOrSkillPath(filename)) reasons.push('only prompt or skill changes can pass');
  }
  if (initialHeadSha && currentHeadSha && initialHeadSha !== currentHeadSha) {
    reasons.push('proposal head changed during discovery');
  }
  const uniqueReasons = [...new Set(reasons)];
  return {
    dataset: selectedDataset.dataset,
    eligible: uniqueReasons.length === 0,
    reasons: uniqueReasons,
  };
}

function refsChanged(decision, pull) {
  return decision.headSha !== pull.head.sha ||
    (decision.baseSha && decision.baseSha !== pull.base.sha);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function validateEvaluationEnvironment({ core }) {
  const required = [
    'LANGFUSE_BASE_URL',
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_SECRET_KEY',
    'LLM_ROUTER_BASE_URL',
    'LLM_ROUTER_API_KEY',
  ];
  const missing = required.filter((name) => !(process.env[name] || '').trim());
  if (missing.length) throw new Error('Missing required evaluation secrets: ' + missing.join(', '));
  if (!['canary', 'full'].includes(process.env.MODE || 'canary')) {
    throw new Error('mode must be canary or full');
  }
  for (const name of ['LANGFUSE_BASE_URL', 'LLM_ROUTER_BASE_URL']) {
    let parsed;
    try {
      parsed = new URL(process.env[name]);
    } catch {
      throw new Error(name + ' must be a valid URL');
    }
    core.setSecret(process.env[name]);
    core.setSecret(parsed.host);
  }
}

async function resolveEvalsRef({ core }) {
  let ref = (process.env.EVALS_REF || '').trim();
  if (!ref) {
    const output = execFileSync(
      'git',
      ['ls-remote', EVALS_REPOSITORY, 'refs/heads/develop'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    ref = output.split(/\s+/)[0] || '';
  }
  if (!/^[0-9a-fA-F]{40}$/.test(ref)) {
    throw new Error('evals_ref must resolve to one 40-character commit SHA');
  }
  core.setOutput('ref', ref);
}

async function fetchTextFile(github, owner, repo, filename, ref) {
  const response = await github.rest.repos.getContent({ owner, repo, path: filename, ref });
  const file = response.data;
  if (!file || Array.isArray(file) || file.type !== 'file' || file.encoding !== 'base64') {
    throw new Error('not a base64 text file');
  }
  const content = Buffer.from(file.content.replace(/\s/g, ''), 'base64');
  if (content.includes(0)) throw new Error('binary prompt content');
  return content.toString('utf8');
}

async function discoverProposals({ github, context, core }) {
  const { owner, repo } = context.repo;
  const workDir = process.env.WORK_DIR || path.dirname(process.env.PLAN_PATH);
  const planPath = process.env.PLAN_PATH;
  if (!planPath || !workDir) throw new Error('PLAN_PATH and WORK_DIR are required');
  fs.mkdirSync(workDir, { recursive: true });
  // pulls.list carries labels, so this needs only pull-requests: read. The issues
  // endpoints would need the issues scope, which this job does not hold.
  const pulls = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });
  const proposals = [];
  for (const listed of pulls) {
    if (!labelNames(listed.labels).includes('learning-proposal')) continue;
    const number = listed.number;
    const files = await github.paginate(github.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    });
    const latest = (await github.rest.pulls.get({ owner, repo, pull_number: number })).data;
    const assessment = assessProposal({
      labels: listed.labels,
      files,
      allowedPaths: process.env.ALLOWED_PATHS,
      initialHeadSha: listed.head.sha,
      currentHeadSha: latest.head.sha,
    });
    const plannedFiles = [];
    const reasons = [...assessment.reasons];
    if (assessment.eligible) {
      try {
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index];
          const baselinePath = path.join(workDir, 'pr-' + number + '-' + index + '-baseline.txt');
          const candidatePath = path.join(workDir, 'pr-' + number + '-' + index + '-candidate.txt');
          // Both reads use the commit SHAs from the listing, so the content is immutable.
          const baseline = await fetchTextFile(github, owner, repo, file.filename, listed.base.sha);
          const candidate = await fetchTextFile(github, owner, repo, file.filename, listed.head.sha);
          fs.writeFileSync(baselinePath, baseline);
          fs.writeFileSync(candidatePath, candidate);
          plannedFiles.push({ index, filename: file.filename, baselinePath, candidatePath });
        }
      } catch {
        reasons.push('changed prompt or skill content could not be read at both refs');
      }
    }
    proposals.push({
      prNumber: number,
      baseSha: listed.base.sha,
      headSha: listed.head.sha,
      dataset: assessment.dataset,
      shouldEvaluate: reasons.length === 0 && plannedFiles.length === files.length && files.length > 0,
      reasons: [...new Set(reasons)],
      files: plannedFiles,
    });
  }
  writeJson(planPath, proposals);
  core.info('Discovered ' + proposals.length + ' open learning-proposal PR(s).');
  return proposals;
}

function runHeldoutEvaluation({ proposal, file, evalsDir, workDir }) {
  const resultPath = path.join(workDir, 'result-' + proposal.prNumber + '-' + file.index + '.json');
  const env = {
    ...process.env,
    HELDOUT_BASELINE_PROMPT: file.baselinePath,
    HELDOUT_CANDIDATE_PROMPT: file.candidatePath,
    LANGFUSE_DATASET_NAME: proposal.dataset,
  };
  let evalStatus = 0;
  try {
    execFileSync('nix', [
      'develop', '--command', 'promptfoo', 'eval', '-c',
      'evals/heldout/promptfooconfig.yaml', '--output', resultPath, '--no-share',
    ], { cwd: evalsDir, env, stdio: 'inherit' });
  } catch (error) {
    evalStatus = error.status;
  }
  if (evalStatus !== 0 && evalStatus !== 100) {
    throw new Error('held-out promptfoo evaluation failed for PR #' + proposal.prNumber);
  }

  let comparison = '';
  let compareStatus = 0;
  try {
    comparison = execFileSync('nix', [
      'develop', '--command', 'python3', 'evals/heldout/heldout.py', 'compare', resultPath,
    ], { cwd: evalsDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (error) {
    comparison = String(error.stdout || '');
    compareStatus = error.status;
  }
  if (compareStatus !== 0 && compareStatus !== 1) {
    throw new Error('held-out score comparison failed for PR #' + proposal.prNumber);
  }
  let score;
  try {
    score = JSON.parse(comparison.split(/\r?\n/)[0]);
  } catch {
    throw new Error('held-out score comparison returned invalid JSON for PR #' + proposal.prNumber);
  }
  if (!Number.isFinite(score.baseline_score) || !Number.isFinite(score.candidate_score) ||
      score.passed !== (compareStatus === 0)) {
    throw new Error('held-out score comparison returned invalid scores for PR #' + proposal.prNumber);
  }
  return {
    prNumber: proposal.prNumber,
    fileIndex: file.index,
    filename: file.filename,
    baselineScore: score.baseline_score,
    candidateScore: score.candidate_score,
    passed: score.passed,
  };
}

async function buildDecisions({ github, context, proposals, scores }) {
  const { owner, repo } = context.repo;
  const scoresByFile = new Map(scores.map((score) => [
    score.prNumber + ':' + score.fileIndex,
    score,
  ]));
  const decisions = [];
  for (const proposal of proposals) {
    const results = proposal.shouldEvaluate
      ? proposal.files.map((file) => {
        const score = scoresByFile.get(proposal.prNumber + ':' + file.index);
        if (!score) throw new Error('evaluation omitted a prompt score');
        return {
          path: file.filename,
          baselineScore: score.baselineScore,
          candidateScore: score.candidateScore,
          passed: score.passed,
        };
      })
      : [];
    const reasons = [...proposal.reasons];
    if (proposal.shouldEvaluate && results.some((score) => !score.passed)) {
      reasons.push('one or more held-out scores were below baseline');
    }
    const pull = (await github.rest.pulls.get({
      owner,
      repo,
      pull_number: proposal.prNumber,
    })).data;
    if (refsChanged(proposal, pull)) reasons.push('proposal refs changed during evaluation');
    const uniqueReasons = [...new Set(reasons)];
    const verdict = proposal.shouldEvaluate && results.length > 0 && uniqueReasons.length === 0
      ? 'pass'
      : 'review';
    decisions.push({
      prNumber: proposal.prNumber,
      headSha: proposal.headSha,
      baseSha: proposal.baseSha,
      verdict,
      reason: uniqueReasons.join('; ') || 'all held-out scores met or exceeded baseline',
      scores: results,
    });
  }
  return decisions;
}

async function evaluate({ github, context, core }) {
  validateEvaluationEnvironment({ core });
  const evalsDir = process.env.EVALS_DIR;
  const workDir = process.env.WORK_DIR || path.dirname(process.env.PLAN_PATH);
  if (!evalsDir || !process.env.SCORES_PATH || !process.env.DECISIONS_PATH) {
    throw new Error('EVALS_DIR, SCORES_PATH, and DECISIONS_PATH are required');
  }
  const proposals = await discoverProposals({ github, context, core });
  const scores = [];
  for (const proposal of proposals) {
    if (!proposal.shouldEvaluate) continue;
    for (const file of proposal.files) {
      scores.push(runHeldoutEvaluation({ proposal, file, evalsDir, workDir }));
    }
  }
  writeJson(process.env.SCORES_PATH, { results: scores });
  const decisions = await buildDecisions({ github, context, proposals, scores });
  writeJson(process.env.DECISIONS_PATH, decisions);
  core.info('Wrote ' + decisions.length + ' held-out learning-gate decision(s).');
}

function escapedInlineCode(value) {
  const tick = String.fromCharCode(96);
  return tick + String(value)
    .replace(/[\x60\\]/g, '\\$&')
    .replace(/[\r\n]/g, ' ') + tick;
}

function commentBody(decision, verdict, reason) {
  const lines = [
    '## Held-out learning gate',
    '',
    'Verdict: **' + verdict + '**',
    'Reason: ' + reason,
    '',
    '### Scores',
  ];
  if (decision.scores.length === 0) {
    lines.push('- No prompt or skill file was eligible for evaluation.');
  } else {
    for (const score of decision.scores) {
      lines.push(
        '- ' + escapedInlineCode(score.path) +
        ': baseline ' + score.baselineScore.toFixed(4) +
        ', candidate ' + score.candidateScore.toFixed(4) +
        (score.passed ? ' (pass)' : ' (below baseline)'),
      );
    }
  }
  return lines.join('\n');
}

async function postDecisionComment({ github, context, core, decision, verdict, reason, workDir }) {
  const bodyPath = path.join(workDir, 'comment-' + decision.prNumber + '.md');
  fs.writeFileSync(bodyPath, commentBody(decision, verdict, reason));
  const oldValues = {
    BODY_FILE: process.env.BODY_FILE,
    MARKER_MATCH: process.env.MARKER_MATCH,
    MARKER_WRITE: process.env.MARKER_WRITE,
    PR_NUMBER: process.env.PR_NUMBER,
  };
  process.env.BODY_FILE = bodyPath;
  process.env.MARKER_MATCH = '<!-- learning-gate -->';
  process.env.MARKER_WRITE = '<!-- learning-gate -->';
  process.env.PR_NUMBER = String(decision.prNumber);
  try {
    await postStickyComment({ github, context, core });
  } finally {
    for (const [name, value] of Object.entries(oldValues)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const HEX_SHA = /^[0-9a-f]{40}$/;

function validScore(score) {
  return score !== null && typeof score === 'object' &&
    typeof score.path === 'string' &&
    Number.isFinite(score.baselineScore) && Number.isFinite(score.candidateScore) &&
    typeof score.passed === 'boolean';
}

// The decisions file crosses a job boundary. Check every field before any write.
function validDecision(decision) {
  return decision !== null && typeof decision === 'object' &&
    Number.isInteger(decision.prNumber) && decision.prNumber > 0 &&
    HEX_SHA.test(decision.headSha) && HEX_SHA.test(decision.baseSha) &&
    ['pass', 'review'].includes(decision.verdict) &&
    typeof decision.reason === 'string' &&
    Array.isArray(decision.scores) && decision.scores.every(validScore);
}

async function publish({ github, context, core }) {
  if (process.env.MODE !== 'full') return;
  const decisions = readJson(process.env.DECISIONS_PATH);
  if (!Array.isArray(decisions)) throw new Error('decisions artifact must be a JSON array');
  const { owner, repo } = context.repo;
  const workDir = process.env.WORK_DIR || path.dirname(process.env.DECISIONS_PATH);
  fs.mkdirSync(workDir, { recursive: true });
  for (const decision of decisions) {
    if (!validDecision(decision)) throw new Error('decisions artifact contains an invalid entry');
    const pull = (await github.rest.pulls.get({
      owner,
      repo,
      pull_number: decision.prNumber,
    })).data;
    if (pull.state !== 'open') continue;
    if (!labelNames(pull.labels).includes('learning-proposal')) continue;
    let verdict = decision.verdict;
    let reason = decision.reason;
    if (verdict === 'pass' && refsChanged(decision, pull)) {
      verdict = 'review';
      reason = 'proposal refs changed after evaluation';
    }
    if (verdict === 'pass') {
      try {
        execFileSync('gh', [
          'pr', 'merge', String(decision.prNumber), '--repo', owner + '/' + repo,
          '--auto', '--squash', '--match-head-commit', decision.headSha,
        ], { env: process.env, stdio: 'inherit' });
        reason = 'all held-out scores met or exceeded baseline; auto-merge requested';
      } catch {
        verdict = 'review';
        reason = 'auto-merge request failed; human review is required';
      }
    }
    if (verdict === 'review') {
      await github.rest.issues.addLabels({
        owner,
        repo,
        issue_number: decision.prNumber,
        labels: ['human:review'],
      });
    }
    await postDecisionComment({
      github,
      context,
      core,
      decision,
      verdict,
      reason,
      workDir,
    });
  }
}

module.exports = {
  assessProposal,
  evaluate,
  isForcedReviewPath,
  matchesGlob,
  publish,
  resolveEvalsRef,
  validateEvaluationEnvironment,
};
