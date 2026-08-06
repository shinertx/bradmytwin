import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const STATE_PATH = '/root/.openclaw/brad-conductor/pending.json';
const SSH_KEY = '/root/.ssh/id_ed25519_brad_gateway';
const SSH_HOST = 'benjijmac@35.188.189.202';
const MAX_PENDING_AGE_MS = 30 * 60 * 1000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function correlationKey(channelId, conversationId) {
  return `${channelId || 'unknown'}:${conversationId || 'unknown'}`;
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { pending: {} };
  } catch {
    return { pending: {} };
  }
}

async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
  const temp = `${STATE_PATH}.tmp`;
  await writeFile(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temp, STATE_PATH);
}

async function gateway(operation, payload) {
  const remoteCommand = payload ? `${operation} ${encode(payload)}` : operation;
  const { stdout } = await execFileAsync('/usr/bin/ssh', [
    '-i', SSH_KEY,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=8',
    SSH_HOST,
    remoteCommand
  ], { timeout: 20_000, maxBuffer: 256 * 1024 });
  const parsed = JSON.parse(stdout.trim());
  if (!parsed?.ok) throw new Error(parsed?.error || 'brad_gateway_rejected');
  return parsed;
}

function assistantText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || message.role !== 'assistant') continue;
    if (typeof message.content === 'string' && message.content.trim()) return message.content.trim();
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => typeof part === 'string' ? part : part?.type === 'text' ? part.text : '')
        .filter(Boolean)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

function commandAllowed(params) {
  const command = typeof params?.command === 'string'
    ? params.command
    : Array.isArray(params?.command) ? params.command.join(' ') : '';
  if (!command || /[;&|`\n\r]|\$\(/.test(command)) return false;
  return /^(?:\/usr\/bin\/timeout 20s )?\/usr\/bin\/ssh -i \/root\/\.ssh\/id_ed25519_brad_gateway -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 benjijmac@35\.188\.189\.202 (?:health|thread-pull|recover|thread-status [0-9a-f-]{36}|thread-reply [A-Za-z0-9_-]+)$/i.test(command);
}

export default {
  id: 'brad-managed-kimi',
  name: 'Brad Managed Kimi Bridge',
  register(api) {
    api.on('message_received', async (event, ctx) => {
      const content = typeof event.content === 'string' ? event.content.trim() : '';
      if (!content || content.startsWith('/')) return;
      const metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
      const timestamp = Number(event.timestamp) || Date.now();
      const channel = String(ctx.channelId || '').toLowerCase().includes('telegram') ? 'TELEGRAM' : 'KIMI';
      const conversationId = String(ctx.conversationId || metadata.conversationId || ctx.channelId || 'managed-kimi');
      const externalMessageId = String(
        metadata.messageId || sha256(`${ctx.channelId}|${conversationId}|${timestamp}|${content}`)
      );
      const result = await gateway('intake', {
        channel,
        externalMessageId,
        conversationId,
        senderId: String(metadata.senderId || event.from || 'owner'),
        timestamp,
        text: content
      });
      const state = await loadState();
      const now = Date.now();
      state.pending = Object.fromEntries(
        Object.entries(state.pending || {}).filter(([, value]) => now - Number(value.createdAt || 0) < MAX_PENDING_AGE_MS)
      );
      state.pending[correlationKey(ctx.channelId, ctx.conversationId)] = {
        jobId: result.jobId,
        threadId: result.threadId,
        objectiveId: result.objectiveId,
        createdAt: now
      };
      await saveState(state);
    }, { priority: 90 });

    api.on('agent_end', async (event, ctx) => {
      if (!event.success) return;
      const text = assistantText(Array.isArray(event.messages) ? event.messages : []);
      if (!text) return;
      const state = await loadState();
      const keyPrefix = `${ctx.channelId || 'unknown'}:`;
      const direct = Object.entries(state.pending || {})
        .filter(([candidate]) => candidate.startsWith(keyPrefix))
        .sort((a, b) => Number(b[1].createdAt || 0) - Number(a[1].createdAt || 0))[0];
      let [pendingKey, pending] = direct || [];
      if (!pending) {
        const candidates = Object.entries(state.pending || {})
          .filter(([, value]) => Date.now() - Number(value.createdAt || 0) < MAX_PENDING_AGE_MS)
          .sort((a, b) => Number(b[1].createdAt || 0) - Number(a[1].createdAt || 0));
        [pendingKey, pending] = candidates[0] || [];
      }
      if (!pending) return;
      await gateway('thread-reply', {
        jobId: pending.jobId,
        threadId: pending.threadId,
        objectiveId: pending.objectiveId,
        sessionId: ctx.sessionId || ctx.sessionKey || null,
        text
      });
      delete state.pending[pendingKey];
      await saveState(state);
    }, { priority: 90 });

    api.on('before_tool_call', async (event) => {
      if (event.toolName === 'exec' && commandAllowed(event.params)) return;
      return {
        block: true,
        blockReason: 'Brad delegates tools through the approval-gated control plane.'
      };
    }, { priority: 100 });
  }
};
