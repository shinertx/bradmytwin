import dotenv from 'dotenv';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  eventField,
  eventList,
  findEventId,
  findEventWithMarker,
  formatBuzzMessage,
  recipientPubkeys,
  type BuzzOutboxPayload
} from './protocol.js';

dotenv.config();
const execFileAsync = promisify(execFile);

const env = z.object({
  BRAD_API_BASE_URL: z.string().default('http://127.0.0.1:3000'),
  BRAD_AGENT_BRIDGE_TOKEN: z.string().min(24),
  BUZZ_CLI_BIN: z.string().default('buzz'),
  BUZZ_RELAY_URL: z.string().default('ws://127.0.0.1:3100'),
  BUZZ_PRIVATE_KEY_FILE: z.string().default('~/.config/buzz/keys/brad-bridge.key'),
  BUZZ_CHANNEL_ID: z.string().uuid(),
  BUZZ_CODEX_PUBKEY: z.string().optional(),
  BUZZ_CLAUDE_PUBKEY: z.string().optional(),
  BUZZ_BRIDGE_PUBKEY: z.string().min(32),
  BUZZ_CODEX_MENTION: z.string().default('@Codex'),
  BUZZ_CLAUDE_MENTION: z.string().default('@Claude'),
  BRAD_BUZZ_POLL_MS: z.coerce.number().int().min(1000).default(3000)
}).parse(process.env);

interface OutboxItem {
  id: string;
  payload_json: BuzzOutboxPayload;
}

interface WaitingJob {
  job_id: string;
  thread_id: string;
  assigned_agent_id: 'codex' | 'claude';
  buzz_event_id: string;
}

function expandHome(file: string): string {
  return file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
}

async function api<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${env.BRAD_API_BASE_URL}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.BRAD_AGENT_BRIDGE_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) throw new Error(`brad_api_${response.status}:${(await response.text()).slice(0, 300)}`);
  return await response.json() as T;
}

async function buzz(args: string[]): Promise<unknown> {
  const privateKey = (await readFile(expandHome(env.BUZZ_PRIVATE_KEY_FILE), 'utf8')).trim();
  if (!privateKey) throw new Error('buzz_private_key_empty');
  const { stdout } = await execFileAsync(env.BUZZ_CLI_BIN, args, {
    env: { ...process.env, BUZZ_RELAY_URL: env.BUZZ_RELAY_URL, BUZZ_PRIVATE_KEY: privateKey },
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  });
  return JSON.parse(stdout) as unknown;
}

async function findPriorPublish(outboxId: string): Promise<string | undefined> {
  const marker = `brad-outbox:${outboxId}`;
  try {
    const existing = await buzz(['messages', 'get', '--channel', env.BUZZ_CHANNEL_ID, '--limit', '100']);
    return findEventWithMarker(existing, marker, env.BUZZ_BRIDGE_PUBKEY)?.eventId;
  } catch {
    return undefined;
  }
}

async function publishOutbox(): Promise<void> {
  const response = await api<{ items: OutboxItem[] }>('/internal/agent/buzz-outbox');
  for (const item of response.items) {
    const payload = item.payload_json ?? {};
    const content = formatBuzzMessage({
      outboxId: item.id,
      payload,
      mentions: { codex: env.BUZZ_CODEX_MENTION, claude: env.BUZZ_CLAUDE_MENTION }
    });
    try {
      const priorEventId = await findPriorPublish(item.id);
      if (priorEventId) {
        await api(`/internal/agent/buzz-outbox/${item.id}/receipt`, {
          method: 'POST',
          body: JSON.stringify({ status: 'PUBLISHED', externalEventId: priorEventId })
        });
        continue;
      }
      const mentions = recipientPubkeys(item.payload_json?.recipients, {
        codex: env.BUZZ_CODEX_PUBKEY,
        claude: env.BUZZ_CLAUDE_PUBKEY
      });
      const result = await buzz([
        'messages', 'send', '--channel', env.BUZZ_CHANNEL_ID, '--content', content,
        ...mentions.flatMap((pubkey) => ['--mention', pubkey])
      ]);
      const eventId = findEventId(result);
      if (!eventId) throw new Error('buzz_send_missing_event_id');
      await api(`/internal/agent/buzz-outbox/${item.id}/receipt`, {
        method: 'POST',
        body: JSON.stringify({ status: 'PUBLISHED', externalEventId: eventId })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'buzz_publish_failed';
      const reconciledEventId = await findPriorPublish(item.id);
      await api(`/internal/agent/buzz-outbox/${item.id}/receipt`, {
        method: 'POST',
        body: JSON.stringify(reconciledEventId
          ? { status: 'PUBLISHED', externalEventId: reconciledEventId }
          : { status: 'RECONCILE_REQUIRED', error: message.slice(0, 1000) })
      }).catch(() => undefined);
    }
  }
}

async function ingestReplies(): Promise<void> {
  const response = await api<{ jobs: WaitingJob[] }>('/internal/agent/buzz-waiting-jobs');
  for (const job of response.jobs) {
    const expectedPubkey = job.assigned_agent_id === 'codex' ? env.BUZZ_CODEX_PUBKEY : env.BUZZ_CLAUDE_PUBKEY;
    if (!expectedPubkey) continue;
    const result = await buzz(['messages', 'thread', '--channel', env.BUZZ_CHANNEL_ID, '--event', job.buzz_event_id]);
    for (const event of eventList(result)) {
      const eventId = eventField(event, ['id', 'event_id', 'eventId']);
      const author = eventField(event, ['pubkey', 'author_pubkey', 'authorPubkey']);
      const text = eventField(event, ['content', 'body', 'text']);
      if (!eventId || !author || !text || author !== expectedPubkey || eventId === job.buzz_event_id) continue;
      const accepted = await api<{ ok: boolean }>('/internal/agent/buzz-replies', {
        method: 'POST',
        body: JSON.stringify({
          jobId: job.job_id,
          agentId: job.assigned_agent_id,
          buzzEventId: eventId,
          text
        })
      }).catch(() => null);
      if (accepted?.ok) break;
    }
  }
}

let running = false;
async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await publishOutbox();
    await ingestReplies();
  } catch (error) {
    console.error('buzz_bridge_tick_failed', error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

console.log('buzz_bridge_started', { relay: env.BUZZ_RELAY_URL, channel: env.BUZZ_CHANNEL_ID });
await tick();
setInterval(() => void tick(), env.BRAD_BUZZ_POLL_MS);
