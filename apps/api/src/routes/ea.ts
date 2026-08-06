import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EAControlService } from '../services/ea-control-service.js';
import { AuditService } from '../services/audit-service.js';

const eaControlService = new EAControlService();
const auditService = new AuditService();

const signalSchema = z.object({
  sourceType: z.enum(['EMAIL', 'SMS', 'WHATSAPP', 'TELEGRAM', 'CALENDAR', 'DRIVE', 'DOCS', 'SHEETS', 'TASKS', 'PORTAL', 'BROWSER', 'CHAT', 'MANUAL', 'SYSTEM']),
  sourceRef: z.string().optional(),
  sender: z.string().optional(),
  subject: z.string().optional(),
  bodyPreview: z.string().min(1).max(5000),
  occurredAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional()
});

const taskSchema = z.object({
  title: z.string().min(1).max(300),
  dueAt: z.string().datetime().nullable().optional(),
  category: z.string().min(1).max(80).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  owner: z.string().min(1).max(120).optional(),
  waitingOn: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  sourceSignalId: z.string().uuid().nullable().optional()
});

const taskUpdateSchema = z.object({
  status: z.enum(['OPEN', 'DONE', 'CANCELLED']).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  waitingOn: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional()
});

const sourceRecordSchema = z.object({
  recordType: z.enum(['PERSON', 'ENTITY', 'ACCOUNT', 'CASE', 'VENDOR', 'PROPERTY', 'PREFERENCE', 'DEADLINE', 'OTHER']),
  title: z.string().min(1).max(300),
  summary: z.string().max(5000).nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  sourceSignalId: z.string().uuid().nullable().optional(),
  confidence: z.enum(['UNVERIFIED', 'USER_ATTESTED', 'SOURCE_BACKED']).optional(),
  metadata: z.record(z.unknown()).optional()
});

const monitorSchema = z.object({
  monitorType: z.enum(['EMAIL', 'SMS', 'CALENDAR', 'DRIVE', 'TASKS', 'PORTAL', 'WEBHOOK', 'SYSTEM']),
  name: z.string().min(1).max(200),
  status: z.enum(['ACTIVE', 'PAUSED', 'ERROR']).optional(),
  cadenceMinutes: z.number().int().min(5).max(10080).optional(),
  metadata: z.record(z.unknown()).optional()
});

export async function eaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ea/dashboard', { preHandler: [app.authenticate] }, async (req) => {
    const user = req.user as { personId: string };
    return await eaControlService.dashboard(user.personId);
  });

  app.post('/ea/signals', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const parsed = signalSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_signal', details: parsed.error.flatten() });
    }

    const result = await eaControlService.ingestSignal({
      personId: user.personId,
      ...parsed.data
    });

    await auditService.log({
      personId: user.personId,
      eventType: 'ea_signal_ingested',
      entityType: 'ea_signal',
      entityId: result.signal.id,
      metadata: {
        sourceType: result.signal.source_type,
        classification: result.signal.classification,
        taskId: result.task?.id ?? null
      }
    });

    return reply.send({ ok: true, ...result });
  });

  app.post('/ea/tasks', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const parsed = taskSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_task', details: parsed.error.flatten() });
    }

    const task = await eaControlService.createTask({
      personId: user.personId,
      ...parsed.data
    });

    await auditService.log({
      personId: user.personId,
      eventType: 'ea_task_created',
      entityType: 'task',
      entityId: task.id,
      metadata: { category: task.category, priority: task.priority }
    });

    return reply.send({ ok: true, task });
  });

  app.patch('/ea/tasks/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const params = req.params as { id: string };
    const parsed = taskUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_task_update', details: parsed.error.flatten() });
    }

    const task = await eaControlService.updateTask({
      personId: user.personId,
      taskId: params.id,
      ...parsed.data
    });
    if (!task) {
      return reply.status(404).send({ error: 'task_not_found' });
    }

    await auditService.log({
      personId: user.personId,
      eventType: 'ea_task_updated',
      entityType: 'task',
      entityId: task.id,
      metadata: { status: task.status }
    });

    return reply.send({ ok: true, task });
  });

  app.post('/ea/source-records', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const parsed = sourceRecordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_source_record', details: parsed.error.flatten() });
    }

    const sourceRecord = await eaControlService.createSourceRecord({
      personId: user.personId,
      ...parsed.data
    });

    await auditService.log({
      personId: user.personId,
      eventType: 'ea_source_record_created',
      entityType: 'ea_source_record',
      entityId: sourceRecord.id,
      metadata: { recordType: sourceRecord.record_type, confidence: sourceRecord.confidence }
    });

    return reply.send({ ok: true, sourceRecord });
  });

  app.post('/ea/monitors', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const parsed = monitorSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_monitor', details: parsed.error.flatten() });
    }

    const monitor = await eaControlService.upsertMonitor({
      personId: user.personId,
      ...parsed.data
    });

    await auditService.log({
      personId: user.personId,
      eventType: 'ea_monitor_upserted',
      entityType: 'ea_monitor',
      entityId: monitor.id,
      metadata: { monitorType: monitor.monitor_type, status: monitor.status }
    });

    return reply.send({ ok: true, monitor });
  });
}
