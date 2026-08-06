import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const manifestPath = process.argv[2] ?? '/tmp/NON_JENNI_TASK_RECONCILIATION_2026-08-03.json';
const personId = process.argv[3];
if (!personId) throw new Error('usage: node import-nonjenni-tasks.mjs MANIFEST_PATH PERSON_ID');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const result = { personId, tasksCreated: 0, tasksExisting: 0, sourceRecordsCreated: 0, sourceRecordsExisting: 0 };

try {
  await client.query('BEGIN');
  for (const card of manifest.taskCards) {
    const summary = `${card.nextAction} Workflow state: ${card.workflowState}. Source: ${card.source}.`;
    const sourceTitle = `[reconciliation] ${card.id}`;
    const sourceRows = await client.query(
      `SELECT id FROM ea_source_records WHERE person_id = $1 AND title = $2 LIMIT 1`,
      [personId, sourceTitle]
    );

    let sourceId = sourceRows.rows[0]?.id;
    if (!sourceId) {
      const inserted = await client.query(
        `INSERT INTO ea_source_records
           (person_id, record_type, title, summary, confidence, metadata_json)
         VALUES ($1, 'OTHER', $2, $3, 'USER_ATTESTED', $4::jsonb)
         RETURNING id`,
        [personId, sourceTitle, summary, JSON.stringify({ reconciliationId: card.id, workflowState: card.workflowState, importable: card.importable })]
      );
      sourceId = inserted.rows[0].id;
      result.sourceRecordsCreated += 1;
    } else {
      result.sourceRecordsExisting += 1;
    }

    if (!card.importable) continue;
    const note = [
      `reconciliation_id=${card.id}`,
      `workflow_state=${card.workflowState}`,
      `next_action=${card.nextAction}`,
      `source=${card.source}`,
      'external_writes=approval_required',
      'medical_or_legal_details=private_and_gated'
    ].join('; ');
    const taskRows = await client.query(
      `SELECT id FROM tasks WHERE person_id = $1 AND notes LIKE $2 LIMIT 1`,
      [personId, `%reconciliation_id=${card.id}%`]
    );
    if (taskRows.rowCount) {
      result.tasksExisting += 1;
      continue;
    }

    const inserted = await client.query(
      `INSERT INTO tasks (id, person_id, title, status, category, priority, owner, notes)
       VALUES ($1, $2, $3, 'OPEN', $4, $5, 'brad', $6)
       RETURNING id`,
      [randomUUID(), personId, card.title, card.category, card.priority, note]
    );
    await client.query(
      `INSERT INTO audit_logs (id, person_id, event_type, entity_type, entity_id, metadata_json)
       VALUES ($1, $2, 'reconciliation_task_imported', 'task', $3, $4::jsonb)`,
      [randomUUID(), personId, inserted.rows[0].id, JSON.stringify({ reconciliationId: card.id, workflowState: card.workflowState, sourceRecordId: sourceId })]
    );
    result.tasksCreated += 1;
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}

console.log(JSON.stringify(result, null, 2));
