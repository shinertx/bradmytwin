#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultContractPath = path.join(repoRoot, 'config', 'linear-shadow-projection.json');
const immutableAuthorityFlags = [
  'linearStatusIsAuthoritative',
  'linearDoneIsCompletionProof',
  'linearDoneIsApproval',
  'linearCommentIsCompletionProof',
  'linearCommentIsApproval'
];

function idSetDigest(ids) {
  return crypto.createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
}

function readJson(filePath) {
  const input = filePath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(filePath, 'utf8');
  return JSON.parse(input);
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function containsExcludedJenniScope(card, blockedTerms) {
  const text = JSON.stringify({
    id: card.id,
    title: card.title,
    category: card.category,
    nextAction: card.nextAction,
    source: card.source
  })
    .toLowerCase()
    .replace(/\bnon[\s_-]*jenni\b/g, '');
  return blockedTerms.find((term) => text.includes(term.toLowerCase()));
}

function unwrapLinearIssues(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.issues)) return value.issues;
  if (Array.isArray(value?.content)) {
    const textBlock = value.content.find((item) => item?.type === 'text' && typeof item.text === 'string');
    if (textBlock) return unwrapLinearIssues(JSON.parse(textBlock.text));
  }
  throw new Error('Linear readback must be an issue array, an { issues } object, or a connector content envelope');
}

function normalizeLinearIssue(issue, contract) {
  const prefix = contract.linear.reconciliationIdPrefix;
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fromDescription = new RegExp(`^${escapedPrefix}([^\\s]+)`, 'm').exec(issue.description ?? '')?.[1];
  return {
    issueId: issue.issueId ?? issue.id ?? null,
    reconciliationId: issue.reconciliationId ?? fromDescription ?? null,
    title: issue.title ?? null,
    status: issue.status?.name ?? issue.status ?? null,
    statusType: issue.status?.type ?? issue.statusType ?? null,
    priority: issue.priority?.value ?? issue.priority ?? null,
    projectId: issue.projectId ?? issue.project?.id ?? null,
    projectName: issue.project?.name ?? (typeof issue.project === 'string' ? issue.project : null),
    teamId: issue.teamId ?? issue.team?.id ?? null,
    teamName: issue.team?.name ?? (typeof issue.team === 'string' ? issue.team : null)
  };
}

function validateContract(contract, errors) {
  if (contract.version !== 1) errors.push(`unsupported contract version: ${contract.version}`);
  if (contract.mode !== 'shadow') errors.push('contract mode must remain shadow');
  if (contract.direction !== 'canonical_to_linear') errors.push('projection direction must remain canonical_to_linear');
  if (contract.writesEnabled !== false) errors.push('shadow projection must not enable Linear writes');
  if (contract.linear?.readbackScope !== 'reconciliation_id_only') {
    errors.push('Linear shadow readback must be scoped to issues with reconciliation IDs');
  }
  if (contract.identity?.sourceField !== 'id' || contract.identity?.immutable !== true) {
    errors.push('taskCards.id must remain the immutable reconciliation identity');
  }
  if (contract.jenniExclusion?.required !== true) errors.push('JENNI exclusion must remain required');
  for (const flag of immutableAuthorityFlags) {
    if (contract.authority?.[flag] !== false) errors.push(`authority.${flag} must remain false`);
  }

  const requiredStateMapping = {
    OPEN: [true, 'Todo', 'unstarted'],
    VERIFY: [true, 'Todo', 'unstarted'],
    BLOCKED: [true, 'Backlog', 'backlog'],
    PARKED: [false, null, null]
  };
  for (const [state, expected] of Object.entries(requiredStateMapping)) {
    const mapping = contract.workflowStateMapping?.[state];
    const actual = [mapping?.included, mapping?.linearStatus ?? null, mapping?.linearStatusType ?? null];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(`invalid ${state} mapping: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    }
  }
  if (Object.values(contract.workflowStateMapping ?? {}).some((mapping) => mapping.linearStatus === 'Done')) {
    errors.push('Done cannot be a canonical workflow-state projection target');
  }
}

function buildProjection(manifest, contract, errors) {
  const cards = manifest.taskCards;
  if (!Array.isArray(cards)) {
    errors.push('manifest.taskCards must be an array');
    return [];
  }

  const ids = cards.map((card) => card.id);
  const duplicateIds = duplicateValues(ids);
  if (duplicateIds.length) errors.push(`duplicate reconciliation IDs: ${duplicateIds.join(', ')}`);
  for (const id of ids) {
    if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      errors.push(`invalid reconciliation ID: ${JSON.stringify(id)}`);
    }
  }

  if (cards.length !== contract.identity.expectedSourceCount) {
    errors.push(`source card count ${cards.length} != ${contract.identity.expectedSourceCount}`);
  }
  if (idSetDigest(ids) !== contract.identity.sourceIdSetSha256) {
    errors.push('immutable source reconciliation-ID set changed');
  }
  if (manifest.policy?.jenniExcluded !== true) errors.push('manifest.policy.jenniExcluded must be true');
  if (manifest.coverage?.excludedJenniCandidates !== contract.jenniExclusion.expectedExcludedCandidateCount) {
    errors.push(
      `excluded JENNI candidate count ${manifest.coverage?.excludedJenniCandidates} != ${contract.jenniExclusion.expectedExcludedCandidateCount}`
    );
  }

  const projection = [];
  const parkedIds = [];
  for (const card of cards) {
    const mapping = contract.workflowStateMapping?.[card.workflowState];
    if (!mapping) {
      errors.push(`${card.id}: unsupported workflow state ${card.workflowState}`);
      continue;
    }
    if (card.importable !== mapping.included) {
      errors.push(`${card.id}: importable=${card.importable} conflicts with ${card.workflowState} mapping`);
    }
    const excludedTerm = containsExcludedJenniScope(card, contract.jenniExclusion.blockedTerms ?? []);
    if (excludedTerm) errors.push(`${card.id}: projected card contains excluded JENNI scope term ${excludedTerm}`);
    const linearPriority = contract.priorityMapping?.[card.priority];
    if (!Number.isInteger(linearPriority)) errors.push(`${card.id}: unsupported priority ${card.priority}`);

    if (!mapping.included) {
      parkedIds.push(card.id);
      continue;
    }
    projection.push({
      reconciliationId: card.id,
      title: card.title,
      status: mapping.linearStatus,
      statusType: mapping.linearStatusType,
      priority: linearPriority,
      projectId: contract.linear.project.id,
      projectName: contract.linear.project.name,
      teamId: contract.linear.team.id,
      teamName: contract.linear.team.name
    });
  }

  if (projection.length !== contract.identity.expectedProjectedCount) {
    errors.push(`projected card count ${projection.length} != ${contract.identity.expectedProjectedCount}`);
  }
  if (parkedIds.length !== contract.identity.expectedParkedCount) {
    errors.push(`parked card count ${parkedIds.length} != ${contract.identity.expectedParkedCount}`);
  }
  if (idSetDigest(projection.map((card) => card.reconciliationId)) !== contract.identity.projectedIdSetSha256) {
    errors.push('immutable projected reconciliation-ID set changed');
  }
  if (idSetDigest(parkedIds) !== contract.identity.parkedIdSetSha256) {
    errors.push('immutable parked reconciliation-ID set changed');
  }

  const coverageChecks = {
    distilledTaskCards: cards.length,
    importableTaskCards: projection.length,
    parkedTaskCards: parkedIds.length
  };
  for (const [field, expected] of Object.entries(coverageChecks)) {
    if (manifest.coverage?.[field] !== expected) {
      errors.push(`manifest.coverage.${field} ${manifest.coverage?.[field]} != ${expected}`);
    }
  }
  return projection;
}

function compareLinearReadback(rawReadback, projection, contract, errors) {
  const allIssues = unwrapLinearIssues(rawReadback).map((issue) => normalizeLinearIssue(issue, contract));
  const issues = contract.linear.readbackScope === 'reconciliation_id_only'
    ? allIssues.filter((issue) => issue.reconciliationId)
    : allIssues;
  const ids = issues.map((issue) => issue.reconciliationId);
  const duplicateIds = duplicateValues(ids.filter(Boolean));
  if (duplicateIds.length) errors.push(`duplicate Linear reconciliation IDs: ${duplicateIds.join(', ')}`);
  for (const issue of issues.filter((item) => !item.reconciliationId)) {
    errors.push(`Linear issue ${issue.issueId ?? '<unknown>'} is missing its reconciliation ID`);
  }

  const expectedById = new Map(projection.map((card) => [card.reconciliationId, card]));
  const actualById = new Map(issues.filter((issue) => issue.reconciliationId).map((issue) => [issue.reconciliationId, issue]));
  const missing = [...expectedById.keys()].filter((id) => !actualById.has(id)).sort();
  const extra = [...actualById.keys()].filter((id) => !expectedById.has(id)).sort();
  if (missing.length) errors.push(`Linear readback missing reconciliation IDs: ${missing.join(', ')}`);
  if (extra.length) errors.push(`Linear readback has extra reconciliation IDs: ${extra.join(', ')}`);

  let matched = 0;
  for (const [id, expected] of expectedById) {
    const actual = actualById.get(id);
    if (!actual) continue;
    const mismatches = [];
    for (const field of ['title', 'status', 'statusType', 'priority']) {
      if (actual[field] !== expected[field]) mismatches.push(`${field}=${JSON.stringify(actual[field])}`);
    }
    const projectMatches = actual.projectId === expected.projectId || actual.projectName === expected.projectName;
    const teamMatches = actual.teamId === expected.teamId || actual.teamName === expected.teamName;
    if (!projectMatches) mismatches.push(`project=${JSON.stringify(actual.projectId ?? actual.projectName)}`);
    if (!teamMatches) mismatches.push(`team=${JSON.stringify(actual.teamId ?? actual.teamName)}`);
    if (mismatches.length) errors.push(`${id}: Linear parity mismatch (${mismatches.join(', ')})`);
    else matched += 1;
  }

  return { actual: issues.length, expected: projection.length, matched, ignored: allIssues.length - issues.length };
}

export function checkLinearShadowParity({ contract, manifest, linearReadback }) {
  const errors = [];
  validateContract(contract, errors);
  const projection = buildProjection(manifest, contract, errors);
  const readback = linearReadback === undefined
    ? { checked: false, expected: projection.length, actual: null, matched: null }
    : { checked: true, ...compareLinearReadback(linearReadback, projection, contract, errors) };

  return {
    ok: errors.length === 0,
    mode: contract.mode,
    direction: contract.direction,
    writesEnabled: contract.writesEnabled,
    canonicalProjection: {
      sourceCards: manifest.taskCards?.length ?? null,
      projected: projection.length,
      expected: contract.identity?.expectedProjectedCount ?? null,
      parity: `${projection.length}/${contract.identity?.expectedProjectedCount ?? '?'}`,
      parked: (manifest.taskCards?.length ?? 0) - projection.length,
      excludedJenniCandidates: manifest.coverage?.excludedJenniCandidates ?? null
    },
    linearReadback: {
      ...readback,
      parity: readback.checked ? `${readback.matched}/${readback.expected}` : 'not-checked'
    },
    authority: contract.authority,
    errors
  };
}

function parseArgs(argv) {
  const args = { contractPath: defaultContractPath, manifestPath: null, linearReadbackPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--contract') args.contractPath = argv[++index];
    else if (arg === '--manifest') args.manifestPath = argv[++index];
    else if (arg === '--linear-readback') args.linearReadbackPath = argv[++index];
    else if (arg === '--help') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log('usage: node tools/check-linear-shadow-parity.mjs [--contract PATH] [--manifest PATH] [--linear-readback PATH|-]');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
    } else {
      const contract = readJson(args.contractPath);
      const manifestPath = args.manifestPath ?? contract.canonicalManifest;
      const result = checkLinearShadowParity({
        contract,
        manifest: readJson(manifestPath),
        linearReadback: args.linearReadbackPath === null ? undefined : readJson(args.linearReadbackPath)
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
