import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { checkLinearShadowParity } from './check-linear-shadow-parity.mjs';

function digest(ids) {
  return crypto.createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
}

test('native Linear control issues are ignored by reconciliation-subset parity', () => {
  const contract = {
    version: 1,
    mode: 'shadow',
    direction: 'canonical_to_linear',
    writesEnabled: false,
    linear: {
      team: { id: 'team-1', name: 'Brad' },
      project: { id: 'project-1', name: 'Brad Non-JENNI Operating Queue' },
      readbackScope: 'reconciliation_id_only',
      reconciliationIdPrefix: 'Reconciliation ID: '
    },
    identity: {
      sourceField: 'id',
      immutable: true,
      expectedSourceCount: 1,
      expectedProjectedCount: 1,
      expectedParkedCount: 0,
      sourceIdSetSha256: digest(['alpha']),
      projectedIdSetSha256: digest(['alpha']),
      parkedIdSetSha256: digest([])
    },
    jenniExclusion: { required: true, expectedExcludedCandidateCount: 0, blockedTerms: [] },
    workflowStateMapping: {
      OPEN: { included: true, linearStatus: 'Todo', linearStatusType: 'unstarted' },
      VERIFY: { included: true, linearStatus: 'Todo', linearStatusType: 'unstarted' },
      BLOCKED: { included: true, linearStatus: 'Backlog', linearStatusType: 'backlog' },
      PARKED: { included: false, linearStatus: null, linearStatusType: null }
    },
    priorityMapping: { URGENT: 1, HIGH: 2, NORMAL: 3, LOW: 4 },
    authority: {
      linearStatusIsAuthoritative: false,
      linearDoneIsCompletionProof: false,
      linearDoneIsApproval: false,
      linearCommentIsCompletionProof: false,
      linearCommentIsApproval: false
    }
  };
  const manifest = {
    policy: { jenniExcluded: true },
    coverage: {
      excludedJenniCandidates: 0,
      distilledTaskCards: 1,
      importableTaskCards: 1,
      parkedTaskCards: 0
    },
    taskCards: [{
      id: 'alpha',
      title: 'Imported issue',
      category: 'operations',
      nextAction: 'Inspect',
      source: 'test',
      workflowState: 'OPEN',
      importable: true,
      priority: 'HIGH'
    }]
  };
  const linearReadback = [
    {
      id: 'linear-imported',
      title: 'Imported issue',
      description: 'Reconciliation ID: alpha',
      status: { name: 'Todo', type: 'unstarted' },
      priority: { value: 2 },
      project: { id: 'project-1', name: 'Brad Non-JENNI Operating Queue' },
      team: { id: 'team-1', name: 'Brad' }
    },
    {
      id: 'linear-native',
      title: 'Native control issue',
      description: 'No reconciliation ID',
      status: { name: 'Done', type: 'completed' },
      priority: { value: 2 },
      project: { id: 'project-1', name: 'Brad Non-JENNI Operating Queue' },
      team: { id: 'team-1', name: 'Brad' }
    }
  ];

  const result = checkLinearShadowParity({ contract, manifest, linearReadback });

  assert.equal(result.ok, true);
  assert.deepEqual(result.linearReadback, {
    checked: true,
    actual: 1,
    expected: 1,
    matched: 1,
    ignored: 1,
    parity: '1/1'
  });
});
