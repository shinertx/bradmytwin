import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { query } from './db.js';

export type SignalSource =
  | 'EMAIL'
  | 'SMS'
  | 'WHATSAPP'
  | 'TELEGRAM'
  | 'CALENDAR'
  | 'DRIVE'
  | 'DOCS'
  | 'SHEETS'
  | 'TASKS'
  | 'PORTAL'
  | 'BROWSER'
  | 'CHAT'
  | 'MANUAL'
  | 'SYSTEM';

export type SignalPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type SignalClassification = 'ACTION' | 'WAITING' | 'SCHEDULE' | 'FILE' | 'REFERENCE' | 'IGNORE' | 'APPROVAL';
export type TaskStatus = 'OPEN' | 'DONE' | 'CANCELLED';

export interface EASignal {
  id: string;
  source_type: SignalSource;
  source_ref: string | null;
  sender: string | null;
  subject: string | null;
  body_preview: string;
  occurred_at: string;
  priority: SignalPriority;
  classification: SignalClassification;
  status: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

export interface EATask {
  id: string;
  title: string;
  due_at: string | null;
  status: TaskStatus;
  category: string;
  priority: SignalPriority;
  owner: string;
  waiting_on: string | null;
  notes: string | null;
  source_signal_id: string | null;
  created_at: string;
}

export interface EASourceRecord {
  id: string;
  record_type: string;
  title: string;
  summary: string | null;
  source_url: string | null;
  confidence: string;
  created_at: string;
  updated_at: string;
}

export interface EAMonitor {
  id: string;
  monitor_type: string;
  name: string;
  status: string;
  cadence_minutes: number;
  last_checked_at: string | null;
  last_error: string | null;
}

const urgentWords = ['urgent', 'asap', 'emergency', 'court', 'deadline', 'overdue', 'past due', 'due today', 'shut off'];
const actionWords = ['please', 'need', 'can you', 'will you', 'todo', 'to-do', 'follow up', 'send', 'call', 'reply', 'review'];
const waitingWords = ['waiting on', 'pending', 'follow up', 'checking in', 'circling back', 'no response'];
const scheduleWords = ['meeting', 'appointment', 'calendar', 'schedule', 'reschedule', 'tomorrow', 'today at', 'zoom'];
const approvalWords = ['approve', 'approval', 'authorize', 'permission', 'confirm'];
const ignoreWords = ['unsubscribe', 'promotion', 'sale ends', 'newsletter'];

function containsAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

export function classifySignal(input: {
  sourceType: SignalSource;
  subject?: string | null;
  bodyPreview: string;
}): { classification: SignalClassification; priority: SignalPriority; category: string; createTask: boolean } {
  const text = `${input.subject ?? ''} ${input.bodyPreview}`.toLowerCase();
  const priority: SignalPriority = containsAny(text, urgentWords) ? 'URGENT' : containsAny(text, ['important', 'high priority']) ? 'HIGH' : 'NORMAL';

  if (containsAny(text, ignoreWords)) {
    return { classification: 'IGNORE', priority: 'LOW', category: 'ignore', createTask: false };
  }

  if (containsAny(text, approvalWords)) {
    return { classification: 'APPROVAL', priority, category: 'approval', createTask: true };
  }

  if (containsAny(text, scheduleWords)) {
    return { classification: 'SCHEDULE', priority, category: 'calendar', createTask: true };
  }

  if (containsAny(text, waitingWords)) {
    return { classification: 'WAITING', priority, category: 'waiting', createTask: true };
  }

  if (containsAny(text, actionWords)) {
    return { classification: 'ACTION', priority, category: input.sourceType === 'EMAIL' ? 'email' : 'general', createTask: true };
  }

  return { classification: 'REFERENCE', priority, category: 'reference', createTask: false };
}

function taskTitleFromSignal(input: { sourceType: SignalSource; sender?: string | null; subject?: string | null; bodyPreview: string }): string {
  const subject = input.subject?.trim();
  if (subject) return subject.slice(0, 180);
  const sender = input.sender ? `${input.sender}: ` : '';
  return `${sender}${input.bodyPreview}`.replace(/\s+/g, ' ').trim().slice(0, 180) || `${input.sourceType} follow-up`;
}

export class EAControlService {
  async ingestSignal(input: {
    personId: string;
    sourceType: SignalSource;
    sourceRef?: string;
    sender?: string;
    subject?: string;
    bodyPreview: string;
    occurredAt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ signal: EASignal; task: EATask | null }> {
    const classified = classifySignal({
      sourceType: input.sourceType,
      subject: input.subject,
      bodyPreview: input.bodyPreview
    });

    const signalRows = await query<EASignal>(
      `INSERT INTO ea_signals (
         person_id, source_type, source_ref, sender, subject, body_preview,
         occurred_at, priority, classification, status, metadata_json
       ) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()),$8,$9,$10,$11)
       RETURNING id, source_type, source_ref, sender, subject, body_preview, occurred_at, priority, classification, status, metadata_json, created_at`,
      [
        input.personId,
        input.sourceType,
        input.sourceRef ?? null,
        input.sender ?? null,
        input.subject ?? null,
        input.bodyPreview,
        input.occurredAt ?? null,
        classified.priority,
        classified.classification,
        classified.createTask ? 'CONVERTED' : classified.classification === 'IGNORE' ? 'IGNORED' : 'NEW',
        JSON.stringify(input.metadata ?? {})
      ]
    );

    const signal = signalRows[0];
    if (!signal) {
      throw new Error('ea_signal_insert_failed');
    }

    let task: EATask | null = null;
    if (classified.createTask) {
      task = await this.createTask({
        personId: input.personId,
        title: taskTitleFromSignal(input),
        category: classified.category,
        priority: classified.priority,
        sourceSignalId: signal.id,
        notes: `${signal.source_type} signal classified as ${classified.classification.toLowerCase()}`
      });
    }

    return { signal, task };
  }

  async createTask(input: {
    personId: string;
    title: string;
    dueAt?: string | null;
    category?: string;
    priority?: SignalPriority;
    owner?: string;
    waitingOn?: string | null;
    notes?: string | null;
    sourceSignalId?: string | null;
  }): Promise<EATask> {
    const rows = await query<EATask>(
      `INSERT INTO tasks (id, person_id, title, due_at, status, category, priority, owner, waiting_on, notes, source_signal_id)
       VALUES ($1,$2,$3,$4,'OPEN',$5,$6,$7,$8,$9,$10)
       RETURNING id, title, due_at, status, category, priority, owner, waiting_on, notes, source_signal_id, created_at`,
      [
        randomUUID(),
        input.personId,
        input.title,
        input.dueAt ?? null,
        input.category ?? 'general',
        input.priority ?? 'NORMAL',
        input.owner ?? 'brad',
        input.waitingOn ?? null,
        input.notes ?? null,
        input.sourceSignalId ?? null
      ]
    );

    const task = rows[0];
    if (!task) {
      throw new Error('ea_task_insert_failed');
    }
    return task;
  }

  async updateTask(input: {
    personId: string;
    taskId: string;
    status?: TaskStatus;
    dueAt?: string | null;
    priority?: SignalPriority;
    waitingOn?: string | null;
    notes?: string | null;
  }): Promise<EATask | null> {
    const rows = await query<EATask>(
      `UPDATE tasks
       SET status = COALESCE($3, status),
           due_at = CASE WHEN $4::text = '__UNCHANGED__' THEN due_at ELSE $4::timestamptz END,
           priority = COALESCE($5, priority),
           waiting_on = CASE WHEN $6::text = '__UNCHANGED__' THEN waiting_on ELSE $6 END,
           notes = CASE WHEN $7::text = '__UNCHANGED__' THEN notes ELSE $7 END,
           completed_at = CASE WHEN $3 = 'DONE' THEN now() ELSE completed_at END,
           updated_at = now()
       WHERE person_id = $1 AND id = $2
       RETURNING id, title, due_at, status, category, priority, owner, waiting_on, notes, source_signal_id, created_at`,
      [
        input.personId,
        input.taskId,
        input.status ?? null,
        input.dueAt === undefined ? '__UNCHANGED__' : input.dueAt,
        input.priority ?? null,
        input.waitingOn === undefined ? '__UNCHANGED__' : input.waitingOn,
        input.notes === undefined ? '__UNCHANGED__' : input.notes
      ]
    );
    return rows[0] ?? null;
  }

  async createSourceRecord(input: {
    personId: string;
    recordType: string;
    title: string;
    summary?: string | null;
    sourceUrl?: string | null;
    sourceSignalId?: string | null;
    confidence?: string;
    metadata?: Record<string, unknown>;
  }): Promise<EASourceRecord> {
    const rows = await query<EASourceRecord>(
      `INSERT INTO ea_source_records (person_id, record_type, title, summary, source_url, source_signal_id, confidence, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, record_type, title, summary, source_url, confidence, created_at, updated_at`,
      [
        input.personId,
        input.recordType,
        input.title,
        input.summary ?? null,
        input.sourceUrl ?? null,
        input.sourceSignalId ?? null,
        input.confidence ?? 'UNVERIFIED',
        JSON.stringify(input.metadata ?? {})
      ]
    );
    const record = rows[0];
    if (!record) {
      throw new Error('ea_source_record_insert_failed');
    }
    return record;
  }

  async upsertMonitor(input: {
    personId: string;
    monitorType: string;
    name: string;
    status?: string;
    cadenceMinutes?: number;
    metadata?: Record<string, unknown>;
  }): Promise<EAMonitor> {
    const rows = await query<EAMonitor>(
      `INSERT INTO ea_monitors (person_id, monitor_type, name, status, cadence_minutes, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (person_id, monitor_type, name)
       DO UPDATE SET status = excluded.status,
                     cadence_minutes = excluded.cadence_minutes,
                     metadata_json = excluded.metadata_json,
                     updated_at = now()
       RETURNING id, monitor_type, name, status, cadence_minutes, last_checked_at, last_error`,
      [
        input.personId,
        input.monitorType,
        input.name,
        input.status ?? 'ACTIVE',
        input.cadenceMinutes ?? 60,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    const monitor = rows[0];
    if (!monitor) {
      throw new Error('ea_monitor_upsert_failed');
    }
    return monitor;
  }

  async dashboard(personId: string): Promise<Record<string, unknown>> {
    const [signals, tasks, waiting, sourceRecords, monitors, approvals, connectors, audit, counts] = await Promise.all([
      query<EASignal>(
        `SELECT id, source_type, source_ref, sender, subject, body_preview, occurred_at, priority, classification, status, metadata_json, created_at
         FROM ea_signals WHERE person_id = $1 ORDER BY occurred_at DESC LIMIT 25`,
        [personId]
      ),
      query<EATask>(
        `SELECT id, title, due_at, status, category, priority, owner, waiting_on, notes, source_signal_id, created_at
         FROM tasks WHERE person_id = $1 AND status = 'OPEN'
         ORDER BY priority DESC, due_at NULLS LAST, created_at DESC LIMIT 25`,
        [personId]
      ),
      query<EATask>(
        `SELECT id, title, due_at, status, category, priority, owner, waiting_on, notes, source_signal_id, created_at
         FROM tasks WHERE person_id = $1 AND status = 'OPEN' AND (category = 'waiting' OR waiting_on IS NOT NULL)
         ORDER BY created_at DESC LIMIT 25`,
        [personId]
      ),
      query<EASourceRecord>(
        `SELECT id, record_type, title, summary, source_url, confidence, created_at, updated_at
         FROM ea_source_records WHERE person_id = $1 ORDER BY updated_at DESC LIMIT 25`,
        [personId]
      ),
      query<EAMonitor>(
        `SELECT id, monitor_type, name, status, cadence_minutes, last_checked_at, last_error
         FROM ea_monitors WHERE person_id = $1 ORDER BY monitor_type, name`,
        [personId]
      ),
      query(
        `SELECT id, action_type, status, status_detail, tool_name, origin_channel, created_at
         FROM approval_requests WHERE person_id = $1 ORDER BY created_at DESC LIMIT 25`,
        [personId]
      ),
      query(
        `SELECT provider, scope, status, expires_at, updated_at
         FROM connectors WHERE person_id = $1 ORDER BY provider, scope`,
        [personId]
      ),
      query(
        `SELECT event_type, entity_type, entity_id, created_at
         FROM audit_logs WHERE person_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [personId]
      ),
      query<{ open_tasks: string; new_signals: string; pending_approvals: string; active_monitors: string }>(
        `SELECT
           (SELECT count(*) FROM tasks WHERE person_id = $1 AND status = 'OPEN')::text AS open_tasks,
           (SELECT count(*) FROM ea_signals WHERE person_id = $1 AND status = 'NEW')::text AS new_signals,
           (SELECT count(*) FROM approval_requests WHERE person_id = $1 AND status = 'PENDING')::text AS pending_approvals,
           (SELECT count(*) FROM ea_monitors WHERE person_id = $1 AND status = 'ACTIVE')::text AS active_monitors`,
        [personId]
      )
    ]);

    return {
      summary: {
        openTasks: Number(counts[0]?.open_tasks ?? 0),
        newSignals: Number(counts[0]?.new_signals ?? 0),
        pendingApprovals: Number(counts[0]?.pending_approvals ?? 0),
        activeMonitors: Number(counts[0]?.active_monitors ?? 0)
      },
      today: tasks,
      waiting,
      signals,
      approvals,
      sourceRecords,
      monitors,
      connectors,
      audit,
      system: {
        mode: env.NODE_ENV,
        openClawMode: env.OPENCLAW_MODE,
        openClawConfigured: Boolean(env.OPENCLAW_URL && env.OPENCLAW_API_KEY),
        smsConfigured: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET),
        googleConfigured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
        writeKillSwitch: env.BETA_KILL_SWITCH_WRITES,
        strictApprovals: env.BETA_STRICT_APPROVALS
      }
    };
  }
}
