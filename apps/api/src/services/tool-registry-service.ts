import type {
  OpenClawToolCall,
  ToolDefinition,
  WriteActionType
} from '@brad/domain';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { query } from './db.js';
import { ConnectorService } from './connector-service.js';

const connectorService = new ConnectorService();

const zDateTime = z.string().min(10);
const zOptionalDateTime = zDateTime.optional();

type ToolMeta = {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
  parser: z.ZodTypeAny;
  isWrite: boolean;
  actionType?: WriteActionType;
  connectorScope?: 'calendar' | 'email';
};

export interface ResolvedToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  isWrite: boolean;
  actionType?: WriteActionType;
  connectorScope?: 'calendar' | 'email';
}

export interface ToolExecutionResult {
  output: Record<string, unknown>;
  errorCode?: string;
  manualNextStep?: string;
}

export class ToolRegistryService {
  private readonly browserAllowlist = env.BROWSER_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);

  private readonly tools: ToolMeta[] = [
    {
      name: 'chat.plan',
      description: 'Create a concise execution plan for a goal.',
      jsonSchema: {
        type: 'object',
        properties: { goal: { type: 'string' } },
        required: ['goal'],
        additionalProperties: false
      },
      parser: z.object({ goal: z.string().min(1) }),
      isWrite: false
    },
    {
      name: 'chat.summarize',
      description: 'Summarize text into concise bullets.',
      jsonSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, maxBullets: { type: 'number' } },
        required: ['text'],
        additionalProperties: false
      },
      parser: z.object({ text: z.string().min(1), maxBullets: z.number().int().min(1).max(10).optional() }),
      isWrite: false
    },
    {
      name: 'chat.extract_intents',
      description: 'Extract intents and entities from text.',
      jsonSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false
      },
      parser: z.object({ text: z.string().min(1) }),
      isWrite: false
    },
    {
      name: 'profile.get_preferences',
      description: 'Retrieve user profile preferences.',
      jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
      parser: z.object({}).passthrough(),
      isWrite: false
    },
    {
      name: 'profile.set_preferences',
      description: 'Update user profile preferences.',
      jsonSchema: {
        type: 'object',
        properties: {
          timezone: { type: 'string' },
          emailSignatureStyle: { type: 'string' }
        },
        additionalProperties: false
      },
      parser: z.object({ timezone: z.string().optional(), emailSignatureStyle: z.string().optional() }),
      isWrite: true,
      actionType: 'SUBMIT_FORM'
    },
    {
      name: 'memory.search_recent_context',
      description: 'Search recent conversation context.',
      jsonSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          maxResults: { type: 'number' }
        },
        required: ['query'],
        additionalProperties: false
      },
      parser: z.object({ query: z.string().min(1), maxResults: z.number().int().min(1).max(25).optional() }),
      isWrite: false
    },
    {
      name: 'calendar.list_events',
      description: 'List calendar events in a time window.',
      jsonSchema: {
        type: 'object',
        properties: {
          timeMin: { type: 'string', format: 'date-time' },
          timeMax: { type: 'string', format: 'date-time' },
          maxResults: { type: 'number' }
        },
        additionalProperties: false
      },
      parser: z.object({ timeMin: zOptionalDateTime, timeMax: zOptionalDateTime, maxResults: z.number().int().min(1).max(50).optional() }),
      isWrite: false,
      connectorScope: 'calendar'
    },
    {
      name: 'calendar.get_event',
      description: 'Get one event by id.',
      jsonSchema: {
        type: 'object',
        properties: { eventId: { type: 'string' } },
        required: ['eventId'],
        additionalProperties: false
      },
      parser: z.object({ eventId: z.string().min(1) }),
      isWrite: false,
      connectorScope: 'calendar'
    },
    {
      name: 'calendar.find_availability',
      description: 'Check availability for a time range.',
      jsonSchema: {
        type: 'object',
        properties: {
          start: { type: 'string', format: 'date-time' },
          end: { type: 'string', format: 'date-time' }
        },
        required: ['start', 'end'],
        additionalProperties: false
      },
      parser: z.object({ start: zDateTime, end: zDateTime }),
      isWrite: false,
      connectorScope: 'calendar'
    },
    {
      name: 'calendar.create_event',
      description: 'Create a calendar event.',
      jsonSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          start: { type: 'string', format: 'date-time' },
          end: { type: 'string', format: 'date-time' },
          timezone: { type: 'string' },
          description: { type: 'string' },
          location: { type: 'string' }
        },
        required: ['summary', 'start', 'end'],
        additionalProperties: false
      },
      parser: z.object({
        summary: z.string().min(1),
        start: zDateTime,
        end: zDateTime,
        timezone: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional()
      }),
      isWrite: true,
      actionType: 'CREATE_EVENT',
      connectorScope: 'calendar'
    },
    {
      name: 'calendar.update_event',
      description: 'Update a calendar event.',
      jsonSchema: {
        type: 'object',
        properties: {
          eventId: { type: 'string' },
          summary: { type: 'string' },
          start: { type: 'string', format: 'date-time' },
          end: { type: 'string', format: 'date-time' },
          timezone: { type: 'string' },
          description: { type: 'string' },
          location: { type: 'string' }
        },
        required: ['eventId'],
        additionalProperties: false
      },
      parser: z.object({
        eventId: z.string().min(1),
        summary: z.string().optional(),
        start: zOptionalDateTime,
        end: zOptionalDateTime,
        timezone: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional()
      }),
      isWrite: true,
      actionType: 'UPDATE_EVENT',
      connectorScope: 'calendar'
    },
    {
      name: 'calendar.delete_event',
      description: 'Delete a calendar event.',
      jsonSchema: {
        type: 'object',
        properties: { eventId: { type: 'string' } },
        required: ['eventId'],
        additionalProperties: false
      },
      parser: z.object({ eventId: z.string().min(1) }),
      isWrite: true,
      actionType: 'UPDATE_EVENT',
      connectorScope: 'calendar'
    },
    {
      name: 'gmail.list_unread',
      description: 'List unread Gmail threads.',
      jsonSchema: {
        type: 'object',
        properties: { maxResults: { type: 'number' } },
        additionalProperties: false
      },
      parser: z.object({ maxResults: z.number().int().min(1).max(50).optional() }),
      isWrite: false,
      connectorScope: 'email'
    },
    {
      name: 'gmail.search_threads',
      description: 'Search Gmail threads.',
      jsonSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          maxResults: { type: 'number' }
        },
        required: ['query'],
        additionalProperties: false
      },
      parser: z.object({ query: z.string().min(1), maxResults: z.number().int().min(1).max(50).optional() }),
      isWrite: false,
      connectorScope: 'email'
    },
    {
      name: 'gmail.read_thread',
      description: 'Read one Gmail thread.',
      jsonSchema: {
        type: 'object',
        properties: { threadId: { type: 'string' } },
        required: ['threadId'],
        additionalProperties: false
      },
      parser: z.object({ threadId: z.string().min(1) }),
      isWrite: false,
      connectorScope: 'email'
    },
    {
      name: 'gmail.draft_reply',
      description: 'Create a Gmail draft reply.',
      jsonSchema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          threadId: { type: 'string' }
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false
      },
      parser: z.object({ to: z.string().email(), subject: z.string().min(1), body: z.string().min(1), threadId: z.string().optional() }),
      isWrite: true,
      actionType: 'SEND_EMAIL',
      connectorScope: 'email'
    },
    {
      name: 'gmail.send_message',
      description: 'Send a Gmail message.',
      jsonSchema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          threadId: { type: 'string' }
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false
      },
      parser: z.object({ to: z.string().email(), subject: z.string().min(1), body: z.string().min(1), threadId: z.string().optional() }),
      isWrite: true,
      actionType: 'SEND_EMAIL',
      connectorScope: 'email'
    },
    {
      name: 'gmail.archive_thread',
      description: 'Archive a Gmail thread.',
      jsonSchema: {
        type: 'object',
        properties: { threadId: { type: 'string' } },
        required: ['threadId'],
        additionalProperties: false
      },
      parser: z.object({ threadId: z.string().min(1) }),
      isWrite: true,
      actionType: 'SEND_EMAIL',
      connectorScope: 'email'
    },
    {
      name: 'reminder.create',
      description: 'Create a reminder.',
      jsonSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          dueAt: { type: 'string', format: 'date-time' }
        },
        required: ['title'],
        additionalProperties: false
      },
      parser: z.object({ title: z.string().min(1), dueAt: zOptionalDateTime }),
      isWrite: true,
      actionType: 'SUBMIT_FORM'
    },
    {
      name: 'reminder.list',
      description: 'List reminders.',
      jsonSchema: { type: 'object', properties: { status: { type: 'string' } }, additionalProperties: false },
      parser: z.object({ status: z.enum(['ACTIVE', 'CANCELLED', 'DONE']).optional() }),
      isWrite: false
    },
    {
      name: 'reminder.cancel',
      description: 'Cancel a reminder.',
      jsonSchema: {
        type: 'object',
        properties: { reminderId: { type: 'string' } },
        required: ['reminderId'],
        additionalProperties: false
      },
      parser: z.object({ reminderId: z.string().uuid() }),
      isWrite: true,
      actionType: 'SUBMIT_FORM'
    },
    {
      name: 'tasks.create',
      description: 'Create a task.',
      jsonSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          dueAt: { type: 'string', format: 'date-time' }
        },
        required: ['title'],
        additionalProperties: false
      },
      parser: z.object({ title: z.string().min(1), dueAt: zOptionalDateTime }),
      isWrite: true,
      actionType: 'SUBMIT_FORM'
    },
    {
      name: 'tasks.list',
      description: 'List tasks.',
      jsonSchema: { type: 'object', properties: { status: { type: 'string' } }, additionalProperties: false },
      parser: z.object({ status: z.enum(['OPEN', 'DONE', 'CANCELLED']).optional() }),
      isWrite: false
    },
    {
      name: 'browser.fetch_page',
      description: 'Fetch text content from an allowlisted URL.',
      jsonSchema: {
        type: 'object',
        properties: { url: { type: 'string', format: 'uri' } },
        required: ['url'],
        additionalProperties: false
      },
      parser: z.object({ url: z.string().url() }),
      isWrite: false
    },
    {
      name: 'browser.extract_structured',
      description: 'Extract basic structured metadata from an allowlisted URL.',
      jsonSchema: {
        type: 'object',
        properties: { url: { type: 'string', format: 'uri' } },
        required: ['url'],
        additionalProperties: false
      },
      parser: z.object({ url: z.string().url() }),
      isWrite: false
    },
    {
      name: 'browser.fill_form',
      description: 'Prepare form submission payload for an allowlisted URL.',
      jsonSchema: {
        type: 'object',
        properties: { url: { type: 'string', format: 'uri' }, fields: { type: 'object' } },
        required: ['url', 'fields'],
        additionalProperties: false
      },
      parser: z.object({ url: z.string().url(), fields: z.record(z.string(), z.any()) }),
      isWrite: true,
      actionType: 'SUBMIT_FORM'
    },
    {
      name: 'browser.submit_form',
      description: 'Submit form data to an allowlisted URL.',
      jsonSchema: {
        type: 'object',
        properties: { url: { type: 'string', format: 'uri' }, fields: { type: 'object' } },
        required: ['url', 'fields'],
        additionalProperties: false
      },
      parser: z.object({ url: z.string().url(), fields: z.record(z.string(), z.any()) }),
      isWrite: true,
      actionType: 'SUBMIT_FORM'
    },
    {
      name: 'files.search_index',
      description: 'Search indexed conversation and audit data.',
      jsonSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          maxResults: { type: 'number' }
        },
        required: ['query'],
        additionalProperties: false
      },
      parser: z.object({ query: z.string().min(1), maxResults: z.number().int().min(1).max(50).optional() }),
      isWrite: false
    }
  ];

  listToolDefinitions(): ToolDefinition[] {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema
    }));
  }

  resolveCall(call: OpenClawToolCall): ResolvedToolCall {
    const tool = this.tools.find((item) => item.name === call.name);
    if (!tool) {
      throw new Error(`tool_not_allowed:${call.name}`);
    }

    const parsed = tool.parser.safeParse(call.arguments ?? {});
    if (!parsed.success) {
      throw new Error(`tool_schema_invalid:${call.name}:${parsed.error.issues.map((i) => i.path.join('.')).join(',')}`);
    }

    return {
      callId: call.id,
      name: call.name,
      args: parsed.data as Record<string, unknown>,
      isWrite: tool.isWrite,
      actionType: tool.actionType,
      connectorScope: tool.connectorScope
    };
  }

  async execute(personId: string, call: ResolvedToolCall): Promise<ToolExecutionResult> {
    switch (call.name) {
      case 'chat.plan':
        return this.execChatPlan(call.args);
      case 'chat.summarize':
        return this.execChatSummarize(call.args);
      case 'chat.extract_intents':
        return this.execExtractIntents(call.args);
      case 'profile.get_preferences':
        return await this.execProfileGet(personId);
      case 'profile.set_preferences':
        return await this.execProfileSet(personId, call.args);
      case 'memory.search_recent_context':
        return await this.execMemorySearch(personId, call.args);
      case 'calendar.list_events':
        return await this.execCalendarList(personId, call.args);
      case 'calendar.get_event':
        return await this.execCalendarGet(personId, call.args);
      case 'calendar.find_availability':
        return await this.execCalendarFreeBusy(personId, call.args);
      case 'calendar.create_event':
        return await this.execCalendarCreate(personId, call.args);
      case 'calendar.update_event':
        return await this.execCalendarUpdate(personId, call.args);
      case 'calendar.delete_event':
        return await this.execCalendarDelete(personId, call.args);
      case 'gmail.list_unread':
        return await this.execGmailListUnread(personId, call.args);
      case 'gmail.search_threads':
        return await this.execGmailSearch(personId, call.args);
      case 'gmail.read_thread':
        return await this.execGmailRead(personId, call.args);
      case 'gmail.draft_reply':
        return await this.execGmailDraft(personId, call.args);
      case 'gmail.send_message':
        return await this.execGmailSend(personId, call.args);
      case 'gmail.archive_thread':
        return await this.execGmailArchive(personId, call.args);
      case 'reminder.create':
        return await this.execReminderCreate(personId, call.args);
      case 'reminder.list':
        return await this.execReminderList(personId, call.args);
      case 'reminder.cancel':
        return await this.execReminderCancel(personId, call.args);
      case 'tasks.create':
        return await this.execTaskCreate(personId, call.args);
      case 'tasks.list':
        return await this.execTaskList(personId, call.args);
      case 'browser.fetch_page':
        return await this.execBrowserFetch(call.args);
      case 'browser.extract_structured':
        return await this.execBrowserExtract(call.args);
      case 'browser.fill_form':
      case 'browser.submit_form':
        return this.execBrowserSubmit(call.args);
      case 'files.search_index':
        return await this.execFileSearch(personId, call.args);
      default:
        return {
          output: {},
          errorCode: 'tool_not_implemented',
          manualNextStep: `Use a manual workflow for ${call.name} right now.`
        };
    }
  }

  private execChatPlan(args: Record<string, unknown>): ToolExecutionResult {
    const goal = String(args.goal || '');
    return {
      output: {
        goal,
        steps: [
          'Clarify desired outcome',
          'Collect required inputs and constraints',
          'Execute actions in order',
          'Confirm result and next follow-up'
        ]
      }
    };
  }

  private execChatSummarize(args: Record<string, unknown>): ToolExecutionResult {
    const text = String(args.text || '');
    const maxBullets = Number(args.maxBullets || 4);
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, Math.max(1, maxBullets));
    return { output: { bullets: sentences } };
  }

  private execExtractIntents(args: Record<string, unknown>): ToolExecutionResult {
    const text = String(args.text || '').toLowerCase();
    const intents = [
      /schedule|calendar|meeting/.test(text) ? 'calendar_action' : null,
      /email|reply|gmail/.test(text) ? 'email_action' : null,
      /task|todo/.test(text) ? 'task_action' : null,
      /remind/.test(text) ? 'reminder_action' : null
    ].filter(Boolean);
    return { output: { intents } };
  }

  private async execProfileGet(personId: string): Promise<ToolExecutionResult> {
    const rows = await query<{ preferred_name: string | null; timezone: string | null; email_signature_style: string | null }>(
      `SELECT preferred_name, timezone, email_signature_style FROM persons WHERE id = $1`,
      [personId]
    );
    return { output: rows[0] ?? {} };
  }

  private async execProfileSet(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const timezone = typeof args.timezone === 'string' ? args.timezone : null;
    const emailSignatureStyle = typeof args.emailSignatureStyle === 'string' ? args.emailSignatureStyle : null;

    await query(
      `UPDATE persons
       SET timezone = COALESCE($2, timezone),
           email_signature_style = COALESCE($3, email_signature_style),
           updated_at = now()
       WHERE id = $1`,
      [personId, timezone, emailSignatureStyle]
    );

    return { output: { updated: true } };
  }

  private async execMemorySearch(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const needle = `%${String(args.query || '').trim()}%`;
    const limit = Number(args.maxResults || 8);
    const rows = await query<{ direction: string; body: string; created_at: string }>(
      `SELECT direction, body, created_at
       FROM messages
       WHERE person_id = $1 AND body ILIKE $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [personId, needle, limit]
    );

    return { output: { results: rows } };
  }

  private async execCalendarList(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const params = new URLSearchParams();
    if (args.timeMin) params.set('timeMin', String(args.timeMin));
    if (args.timeMax) params.set('timeMax', String(args.timeMax));
    params.set('singleEvents', 'true');
    params.set('orderBy', 'startTime');
    params.set('maxResults', String(args.maxResults ?? 20));

    return await this.googleCalendarRequest(personId, `events?${params.toString()}`, 'GET');
  }

  private async execCalendarGet(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    return await this.googleCalendarRequest(personId, `events/${encodeURIComponent(String(args.eventId))}`, 'GET');
  }

  private async execCalendarFreeBusy(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    return await this.googleCalendarRequest(personId, 'freeBusy', 'POST', {
      timeMin: args.start,
      timeMax: args.end,
      items: [{ id: 'primary' }]
    });
  }

  private async execCalendarCreate(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    return await this.googleCalendarRequest(personId, 'events', 'POST', {
      summary: args.summary,
      description: args.description,
      location: args.location,
      start: {
        dateTime: args.start,
        timeZone: args.timezone ?? 'UTC'
      },
      end: {
        dateTime: args.end,
        timeZone: args.timezone ?? 'UTC'
      }
    });
  }

  private async execCalendarUpdate(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const patch: Record<string, unknown> = {};
    if (args.summary) patch.summary = args.summary;
    if (args.description) patch.description = args.description;
    if (args.location) patch.location = args.location;
    if (args.start) patch.start = { dateTime: args.start, timeZone: args.timezone ?? 'UTC' };
    if (args.end) patch.end = { dateTime: args.end, timeZone: args.timezone ?? 'UTC' };

    return await this.googleCalendarRequest(
      personId,
      `events/${encodeURIComponent(String(args.eventId))}`,
      'PATCH',
      patch
    );
  }

  private async execCalendarDelete(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    return await this.googleCalendarRequest(personId, `events/${encodeURIComponent(String(args.eventId))}`, 'DELETE');
  }

  private async execGmailListUnread(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const maxResults = Number(args.maxResults ?? 20);
    return await this.googleGmailRequest(personId, `threads?q=is:unread&maxResults=${maxResults}`, 'GET');
  }

  private async execGmailSearch(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const maxResults = Number(args.maxResults ?? 20);
    return await this.googleGmailRequest(personId, `threads?q=${encodeURIComponent(String(args.query))}&maxResults=${maxResults}`, 'GET');
  }

  private async execGmailRead(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    return await this.googleGmailRequest(personId, `threads/${encodeURIComponent(String(args.threadId))}?format=full`, 'GET');
  }

  private async execGmailDraft(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const raw = this.buildRawEmail(String(args.to), String(args.subject), String(args.body));
    return await this.googleGmailRequest(personId, 'drafts', 'POST', {
      message: {
        raw,
        ...(args.threadId ? { threadId: args.threadId } : {})
      }
    });
  }

  private async execGmailSend(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const raw = this.buildRawEmail(String(args.to), String(args.subject), String(args.body));
    return await this.googleGmailRequest(personId, 'messages/send', 'POST', {
      raw,
      ...(args.threadId ? { threadId: args.threadId } : {})
    });
  }

  private async execGmailArchive(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    return await this.googleGmailRequest(
      personId,
      `threads/${encodeURIComponent(String(args.threadId))}/modify`,
      'POST',
      { removeLabelIds: ['INBOX'] }
    );
  }

  private async execReminderCreate(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const rows = await query<{ id: string }>(
      `INSERT INTO reminders (person_id, title, due_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [personId, String(args.title), args.dueAt ? String(args.dueAt) : null]
    );

    return { output: { reminderId: rows[0]?.id } };
  }

  private async execReminderList(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const status = args.status ? String(args.status) : null;
    const rows = await query<{ id: string; title: string; due_at: string | null; status: string }>(
      `SELECT id, title, due_at, status
       FROM reminders
       WHERE person_id = $1
         AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC
       LIMIT 100`,
      [personId, status]
    );

    return { output: { reminders: rows } };
  }

  private async execReminderCancel(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    await query(
      `UPDATE reminders
       SET status = 'CANCELLED', updated_at = now()
       WHERE person_id = $1 AND id = $2`,
      [personId, String(args.reminderId)]
    );

    return { output: { cancelled: true } };
  }

  private async execTaskCreate(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const rows = await query<{ id: string }>(
      `INSERT INTO tasks (person_id, title, due_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [personId, String(args.title), args.dueAt ? String(args.dueAt) : null]
    );

    return { output: { taskId: rows[0]?.id } };
  }

  private async execTaskList(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const status = args.status ? String(args.status) : null;
    const rows = await query<{ id: string; title: string; due_at: string | null; status: string }>(
      `SELECT id, title, due_at, status
       FROM tasks
       WHERE person_id = $1
         AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC
       LIMIT 100`,
      [personId, status]
    );

    return { output: { tasks: rows } };
  }

  private async execBrowserFetch(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const url = String(args.url || '');
    if (!this.isAllowlisted(url)) {
      return {
        output: {},
        errorCode: 'browser_domain_not_allowlisted',
        manualNextStep: 'Open the site manually and verify domain allowlist in settings.'
      };
    }

    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      return {
        output: {},
        errorCode: `browser_fetch_${res.status}`,
        manualNextStep: 'Open the URL manually to verify access.'
      };
    }

    const html = await res.text();
    return {
      output: {
        url,
        status: res.status,
        title: this.extractTitle(html),
        snippet: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800)
      }
    };
  }

  private async execBrowserExtract(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const fetched = await this.execBrowserFetch(args);
    if (fetched.errorCode) {
      return fetched;
    }

    const snippet = String(fetched.output.snippet ?? '');
    return {
      output: {
        url: fetched.output.url,
        title: fetched.output.title,
        paragraphs: snippet.split('. ').slice(0, 5)
      }
    };
  }

  private execBrowserSubmit(args: Record<string, unknown>): ToolExecutionResult {
    const url = String(args.url || '');
    if (!this.isAllowlisted(url)) {
      return {
        output: {},
        errorCode: 'browser_domain_not_allowlisted',
        manualNextStep: 'Use a domain on the allowlist before submitting browser forms.'
      };
    }

    return {
      output: {
        requestId: randomUUID(),
        status: 'accepted',
        note: 'Form action recorded for controlled execution.'
      }
    };
  }

  private async execFileSearch(personId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const needle = `%${String(args.query || '')}%`;
    const limit = Number(args.maxResults ?? 15);

    const msgRows = await query<{ source: string; value: string; created_at: string }>(
      `SELECT 'message' AS source, body AS value, created_at
       FROM messages
       WHERE person_id = $1 AND body ILIKE $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [personId, needle, limit]
    );

    const auditRows = await query<{ source: string; value: string; created_at: string }>(
      `SELECT 'audit' AS source, event_type AS value, created_at
       FROM audit_logs
       WHERE person_id = $1 AND event_type ILIKE $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [personId, needle, limit]
    );

    return { output: { results: [...msgRows, ...auditRows].slice(0, limit) } };
  }

  private async googleCalendarRequest(
    personId: string,
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    const token = await connectorService.getGoogleAccessToken(personId, 'calendar');
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/${path}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        output: {},
        errorCode: `google_calendar_${res.status}`,
        manualNextStep: `Google Calendar request failed: ${text.slice(0, 160)}`
      };
    }

    if (res.status === 204) {
      return { output: { ok: true } };
    }

    return { output: (await res.json()) as Record<string, unknown> };
  }

  private async googleGmailRequest(
    personId: string,
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    const token = await connectorService.getGoogleAccessToken(personId, 'email');
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/${path}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        output: {},
        errorCode: `google_gmail_${res.status}`,
        manualNextStep: `Gmail request failed: ${text.slice(0, 160)}`
      };
    }

    return { output: (await res.json()) as Record<string, unknown> };
  }

  private buildRawEmail(to: string, subject: string, body: string): string {
    const mime = [
      `To: ${to}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      `Subject: ${subject}`,
      '',
      body
    ].join('\r\n');

    return Buffer.from(mime)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  private isAllowlisted(rawUrl: string): boolean {
    try {
      const url = new URL(rawUrl);
      return this.browserAllowlist.some((allowed) =>
        url.hostname === allowed || url.hostname.endsWith(`.${allowed}`)
      );
    } catch {
      return false;
    }
  }

  private extractTitle(html: string): string | null {
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return m ? m[1].trim() : null;
  }
}
