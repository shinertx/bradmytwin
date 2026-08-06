import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SSH_KEY = '/root/.ssh/id_ed25519_brad_gateway';
const SSH_HOST = 'benjijmac@35.188.189.202';
const MAX_RUN_AGE_MS = 30 * 60 * 1000;
const MAX_RUN_ID_LENGTH = 243;
const CLAIM_RENEW_INTERVAL_MS = 60 * 1000;
const RECOVERY_SCAN_INTERVAL_MS = 2 * 60 * 1000;
const DELIVERY_RECEIPT_TIMEOUT_MS = 30 * 1000;
const MAX_RECOVERIES_PER_SCAN = 20;
const MANAGED_CONTINUATION_MAX_AGE_MS = 30 * 1000;
const RECOVERY_PACKET_PREFIX = 'BRAD_RECOVERY_PACKET_V1:';
const CONFIG_KEYS = new Set([
  'managedAgentId',
  'managedMainAccountDigest',
  'managedOwnerIdentity',
  'managedTelegramBindingDigest',
  'managedTelegramOwnerDigest',
  'modelProvider',
  'model',
  'recoveryEnabled'
]);
const BRAD_EXECUTIVE_SYSTEM_CONTEXT = [
  'You are Brad, Ben\'s Kimi-powered executive identity inside a durable multi-agent control plane.',
  'Treat every normal owner message as an objective. Reason proportionally using: objective, binding constraint, hidden assumption, strongest candidate, strongest attack, repaired decision, and decisive proof test.',
  'Take a position. Return a concise owner-readable executive decision that also gives the next specialist an unambiguous assignment and proof requirement.',
  'Do not perform tools or external effects directly. The control plane delegates one next agent, preserves the full discussion in Buzz, and independently verifies completion.',
  'Delegation happens automatically after your response. Never call or discuss agents_list, sessions_spawn, sessions_send, or tool availability; state the assignment and proof contract as a decision, not as a request to spawn an agent.',
  'Never expand authority, access JENNI, expose credentials, or bypass exact-action approval for sends, spending, deletion, deployment, legal action, publication, or credential changes.',
  'Do not call work complete without source-of-record evidence. State a precise blocker when proof or authority is missing.'
].join('\n');

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
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
  ], { timeout: 12_000, maxBuffer: 256 * 1024 });
  const parsed = JSON.parse(stdout.trim());
  if (!parsed?.ok) throw new Error(parsed?.error || 'brad_gateway_rejected');
  return parsed;
}

function messageText(message) {
  if (typeof message === 'string') return message.trim();
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => typeof part === 'string' ? part : part?.type === 'text' ? part.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function assistantText(event) {
  const finalText = messageText(event?.lastAssistantMessage);
  if (finalText) return finalText;
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'assistant') continue;
    const text = messageText(messages[index]);
    if (text) return text;
  }
  return '';
}

function commandAllowed(params) {
  const command = typeof params?.command === 'string'
    ? params.command
    : Array.isArray(params?.command) ? params.command.join(' ') : '';
  if (!command || /[;&|`\n\r]|\$\(/.test(command)) return false;
  return /^(?:\/usr\/bin\/timeout 20s )?\/usr\/bin\/ssh -i \/root\/\.ssh\/id_ed25519_brad_gateway -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 benjijmac@35\.188\.189\.202 (?:health|thread-status [0-9a-f-]{36})$/i.test(command);
}

function normalizedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedOwnerPrompt(value) {
  const prompt = normalizedString(value);
  const marker = '\nUser Message From Kimi:\n';
  const markerIndex = prompt.lastIndexOf(marker);
  if (markerIndex < 0) return prompt;
  return normalizedString(prompt.slice(markerIndex + marker.length))
    .replace(/^\[Time:\s*\[[^\r\n]*\]\]\s*/i, '')
    .trim();
}

function promptDigest(value) {
  const prompt = normalizedString(value);
  return prompt ? createHash('sha256').update(prompt, 'utf8').digest('hex') : '';
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

function responseDigest(value) {
  const text = normalizedString(value);
  return text
    ? createHash('sha256').update(canonicalJson({ text, artifactRefs: [], evidenceRefs: [] })).digest('hex')
    : '';
}

function safeClaimFailureCode(error) {
  const message = error instanceof Error ? normalizedString(error.message) : '';
  return /^(?:managed_kimi|brad_gateway)_[a-z0-9_]+$/.test(message)
    ? message
    : 'managed_kimi_claim_failed';
}

function runIdFrom(...values) {
  for (const source of values) {
    const value = source?.runId;
    if (
      typeof value === 'string'
      && value
      && value.length <= MAX_RUN_ID_LENGTH
      && value === value.trim()
      && /^[A-Za-z0-9._:-]+$/.test(value)
    ) return value;
  }
  return '';
}

function configString(config, key, pattern, maxLength) {
  const value = normalizedString(config[key]);
  if (!value || value.length > maxLength || !pattern.test(value)) {
    throw new Error(`brad-managed-kimi requires a valid pluginConfig.${key}`);
  }
  return value;
}

function parsePluginConfig(pluginConfig) {
  if (!pluginConfig || typeof pluginConfig !== 'object' || Array.isArray(pluginConfig)) {
    throw new Error('brad-managed-kimi requires pluginConfig');
  }
  const unknownKeys = Object.keys(pluginConfig).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`brad-managed-kimi received unknown pluginConfig key: ${unknownKeys[0]}`);
  }
  if (typeof pluginConfig.recoveryEnabled !== 'boolean') {
    throw new Error('brad-managed-kimi requires a boolean pluginConfig.recoveryEnabled');
  }
  return Object.freeze({
    managedAgentId: configString(pluginConfig, 'managedAgentId', /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 128),
    managedMainAccountDigest: configString(
      pluginConfig,
      'managedMainAccountDigest',
      /^[0-9a-f]{64}$/,
      64
    ).toLowerCase(),
    managedOwnerIdentity: configString(
      pluginConfig,
      'managedOwnerIdentity',
      /^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._:-]*$/,
      384
    ).toLowerCase(),
    managedTelegramBindingDigest: configString(
      pluginConfig,
      'managedTelegramBindingDigest',
      /^[0-9a-f]{64}$/,
      64
    ).toLowerCase(),
    managedTelegramOwnerDigest: configString(
      pluginConfig,
      'managedTelegramOwnerDigest',
      /^[0-9a-f]{64}$/,
      64
    ).toLowerCase(),
    modelProvider: configString(pluginConfig, 'modelProvider', /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 128),
    model: configString(pluginConfig, 'model', /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 256),
    recoveryEnabled: pluginConfig.recoveryEnabled
  });
}

function isManagedBradRun(ctx, config) {
  if (normalizedString(ctx?.trigger).toLowerCase() === 'cron') return false;
  return normalizedString(ctx?.agentId) === config.managedAgentId;
}

function sourceChannel(event, ctx) {
  const providers = [event?.channelId, event?.channel, ctx?.messageProvider, ctx?.channel]
    .map((value) => normalizedString(value).toLowerCase())
    .filter(Boolean);
  if (providers.some((provider) => provider.includes('telegram'))) return 'TELEGRAM';
  if (providers.some((provider) => provider.includes('kimi'))) return 'KIMI';
  return 'WEB';
}

function boundedContextValues(values, maxLength) {
  return [...new Set(values
    .map((value) => normalizedString(value))
    .filter((value) => value && value.length <= maxLength))];
}

function exactTelegramId(value) {
  return typeof value === 'string'
    && value.length <= 20
    && value === value.trim()
    && /^[1-9][0-9]{4,19}$/.test(value)
    ? value
    : '';
}

function exactAccountId(value) {
  return typeof value === 'string'
    && value.length <= 128
    && value === value.trim()
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    ? value
    : '';
}

function optionalExact(value, expected, normalizer = (candidate) => candidate) {
  if (value === undefined || value === null) return true;
  return normalizer(value) === expected;
}

function matchedManagedPrincipal(identity, providers, principals) {
  for (const provider of providers) {
    for (const principal of principals) {
      if (`${provider}:${principal}`.toLowerCase() === identity) return principal;
    }
  }
  return '';
}

function ownerProofFailure(identity, providers, principals) {
  const expectedProvider = identity.slice(0, identity.indexOf(':'));
  if (!providers.some((provider) => provider.toLowerCase() === expectedProvider)) {
    return 'managed_kimi_owner_provider_mismatch';
  }
  if (principals.length === 0) return 'managed_kimi_owner_subject_required';
  return 'managed_kimi_owner_identity_mismatch';
}

function safeMetadataKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'none';
  const keys = Object.keys(value)
    .filter((key) => /^[A-Za-z][A-Za-z0-9_]*$/.test(key))
    .sort()
    .slice(0, 64);
  return keys.length > 0 ? keys.join(',') : 'none';
}

function safeOwnerContextShape(event, ctx, config) {
  const channelContext = ctx?.channelContext;
  const sender = channelContext && typeof channelContext === 'object'
    ? channelContext.sender
    : null;
  const chat = channelContext && typeof channelContext === 'object'
    ? channelContext.chat
    : null;
  const ownerSeparator = config.managedOwnerIdentity.indexOf(':');
  const ownerPrincipal = config.managedOwnerIdentity.slice(ownerSeparator + 1);
  const sessionKey = normalizedString(ctx?.sessionKey);
  const contextRunId = runIdFrom(ctx);
  const eventRunId = runIdFrom(event);
  const telegramSenderId = exactTelegramId(event?.senderId);
  const telegramChatId = exactTelegramId(chat?.id);
  return [
    `event_keys=${safeMetadataKeys(event)}`,
    `ctx_keys=${safeMetadataKeys(ctx)}`,
    `channel_context_keys=${safeMetadataKeys(channelContext)}`,
    `channel_sender_keys=${safeMetadataKeys(sender)}`,
    `channel_chat_keys=${safeMetadataKeys(chat)}`,
    `sender_is_owner=${event?.senderIsOwner === true}`,
    `sender_is_non_owner=${event?.senderIsOwner === false}`,
    `event_sender_present=${Boolean(normalizedString(event?.senderId))}`,
    `ctx_sender_present=${Boolean(normalizedString(ctx?.senderId))}`,
    `event_account_present=${Boolean(normalizedString(event?.accountId))}`,
    `ctx_account_present=${Boolean(normalizedString(ctx?.accountId))}`,
    `event_account_matches_owner=${normalizedString(event?.accountId).toLowerCase() === ownerPrincipal}`,
    `event_account_matches_managed_digest=${promptDigest(event?.accountId) === config.managedMainAccountDigest}`,
    `event_sender_matches_telegram_digest=${promptDigest(event?.senderId) === config.managedTelegramOwnerDigest}`,
    `ctx_sender_matches_telegram_digest=${promptDigest(ctx?.senderId) === config.managedTelegramOwnerDigest}`,
    `telegram_binding_matches=${promptDigest(`telegram:v1:${event?.accountId}:${event?.senderId}:${chat?.id}`) === config.managedTelegramBindingDigest}`,
    `provider_is_exact_telegram=${ctx?.messageProvider === 'telegram'}`,
    `ctx_channel_absent_or_telegram=${optionalExact(ctx?.channel, 'telegram')}`,
    `ctx_channel_id_absent_or_telegram=${optionalExact(ctx?.channelId, 'telegram')}`,
    `event_channel_absent_or_telegram=${optionalExact(event?.channel, 'telegram')}`,
    `event_channel_id_absent_or_telegram=${optionalExact(event?.channelId, 'telegram')}`,
    `trigger_is_user=${ctx?.trigger === 'user'}`,
    `event_trigger_absent_or_user=${optionalExact(event?.trigger, 'user')}`,
    `private_chat_matches_sender=${exactTelegramId(chat?.id) === exactTelegramId(event?.senderId)}`,
    `ctx_chat_absent_or_matches=${optionalExact(ctx?.chatId, telegramChatId, exactTelegramId)}`,
    `ctx_conversation_absent_or_matches=${optionalExact(ctx?.conversationId, telegramChatId, exactTelegramId)}`,
    `event_chat_absent_or_matches=${optionalExact(event?.chatId, telegramChatId, exactTelegramId)}`,
    `event_conversation_absent_or_matches=${optionalExact(event?.conversationId, telegramChatId, exactTelegramId)}`,
    `ctx_account_absent_or_matches=${optionalExact(ctx?.accountId, exactAccountId(event?.accountId), exactAccountId)}`,
    `ctx_run_id_present=${Boolean(contextRunId)}`,
    `event_run_id_absent_or_valid=${!Object.hasOwn(event ?? {}, 'runId') || Boolean(eventRunId)}`,
    `event_run_id_absent_or_matches=${!eventRunId || eventRunId === contextRunId}`,
    `telegram_sender_is_exact=${Boolean(telegramSenderId)}`,
    `telegram_chat_is_exact=${Boolean(telegramChatId)}`,
    `session_is_boot=${sessionKey === `agent:${config.managedAgentId}:boot`}`,
    `session_is_main=${sessionKey === `agent:${config.managedAgentId}:${ownerPrincipal}`}`,
    `prompt_present=${Boolean(normalizedString(event?.prompt))}`
  ].join(' ');
}

function boundedContextValue(values, maxLength, fallback = '') {
  for (const value of values) {
    const normalized = normalizedString(value);
    if (normalized && normalized.length <= maxLength) return normalized;
  }
  return fallback;
}

function claimField(result, key, maxLength) {
  const value = normalizedString(result?.[key]);
  if (!value || value.length > maxLength) throw new Error(`brad_gateway_invalid_${key}`);
  return value;
}

function validateClaim(result) {
  if (!result || typeof result !== 'object' || result.ok === false) {
    throw new Error('brad_gateway_intake_rejected');
  }
  if (result.settled === true) throw new Error('brad_gateway_message_already_settled');
  return Object.freeze({
    inboundId: claimField(result, 'inboundId', 256),
    claimToken: claimField(result, 'claimToken', 4096),
    jobId: claimField(result, 'jobId', 256),
    threadId: claimField(result, 'threadId', 256),
    objectiveId: claimField(result, 'objectiveId', 256)
  });
}

function validateRecoveryAssignment(result) {
  const assignment = result?.assignment;
  if (!result?.ok || !assignment || typeof assignment !== 'object') {
    throw new Error('brad_gateway_recovery_assignment_invalid');
  }
  return Object.freeze({
    inboundId: claimField(assignment, 'inbound_id', 256),
    claimToken: claimField(assignment, 'claimToken', 4096),
    jobId: claimField(assignment, 'job_id', 256),
    threadId: claimField(assignment, 'thread_id', 256),
    objectiveId: claimField(assignment, 'objective_id', 256),
    sessionKey: claimField(assignment, 'session_key', 512),
    channel: claimField(assignment, 'channel', 20),
    conversationId: claimField(assignment, 'conversation_id', 512),
    goal: claimField(assignment, 'goal', 100_000),
    definitionOfDone: claimField(assignment, 'definition_of_done', 100_000),
    verificationMethod: claimField(assignment, 'verification_method', 100_000),
    messages: Array.isArray(assignment.messages) ? assignment.messages.slice(-12) : []
  });
}

function buildRecoveryPacket(assignment, nonce) {
  const packet = {
    v: 1,
    nonce,
    inboundId: assignment.inboundId,
    objectiveId: assignment.objectiveId,
    threadId: assignment.threadId,
    jobId: assignment.jobId,
    goal: assignment.goal,
    definitionOfDone: assignment.definitionOfDone,
    verificationMethod: assignment.verificationMethod,
    messages: assignment.messages
  };
  return `${RECOVERY_PACKET_PREFIX}${encode(packet)}`;
}

function parseRecoveryPacket(prompt) {
  const text = normalizedString(prompt);
  if (!text.startsWith(RECOVERY_PACKET_PREFIX)) return null;
  const encoded = text.slice(RECOVERY_PACKET_PREFIX.length);
  if (!encoded || encoded.length > 200_000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const packet = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (packet?.v !== 1) return null;
    for (const key of ['nonce', 'inboundId', 'objectiveId', 'threadId', 'jobId']) {
      if (!normalizedString(packet[key])) return null;
    }
    return packet;
  } catch {
    return null;
  }
}

export function createManagedKimiPlugin(options = {}) {
  const callGateway = options.gateway || gateway;
  const now = options.now || Date.now;
  const scheduleInterval = options.setInterval || globalThis.setInterval;
  const cancelInterval = options.clearInterval || globalThis.clearInterval;
  const scheduleTimeout = options.setTimeout || globalThis.setTimeout;
  const cancelTimeout = options.clearTimeout || globalThis.clearTimeout;
  const randomId = options.randomUUID || randomUUID;
  if (typeof callGateway !== 'function') throw new TypeError('gateway must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof scheduleInterval !== 'function' || typeof cancelInterval !== 'function') {
    throw new TypeError('interval scheduler must be a function');
  }
  if (typeof scheduleTimeout !== 'function' || typeof cancelTimeout !== 'function') {
    throw new TypeError('timeout scheduler must be a function');
  }

  return {
    id: 'brad-managed-kimi',
    name: 'Brad Managed Kimi Bridge',
    register(api) {
      const config = parsePluginConfig(api.pluginConfig);
      const scheduleSessionTurn = api?.session?.workflow?.scheduleSessionTurn;
      if (config.recoveryEnabled && typeof scheduleSessionTurn !== 'function') {
        throw new Error('brad-managed-kimi recovery requires api.session.workflow.scheduleSessionTurn');
      }

      const runStates = new Map();
      const inboundStates = new Map();
      const recoveryClaims = new Map();
      const recoveryOwner = `openclaw-recovery:${randomId()}`;
      let recoveryTimer = null;
      let recoveryScanActive = false;
      let ownerContextShapeLogged = false;
      let continuationDiagnosticLogged = false;
      const ownerSeparator = config.managedOwnerIdentity.indexOf(':');
      const configuredOwnerPrincipal = config.managedOwnerIdentity.slice(ownerSeparator + 1);
      const managedBootSessionKey = `agent:${config.managedAgentId}:boot`;
      const managedMainSessionKey = `agent:${config.managedAgentId}:${configuredOwnerPrincipal}`;

      const isAuthenticatedManagedMainRun = (event, ctx) => (
        boundedContextValue([ctx?.sessionKey], 512) === managedMainSessionKey
        && event?.senderIsOwner === false
        && !normalizedString(event?.senderId)
        && !normalizedString(ctx?.senderId)
        && promptDigest(event?.accountId) === config.managedMainAccountDigest
      );

      const telegramOwnerProof = (event, ctx) => {
        if (ctx?.messageProvider !== 'telegram') return null;
        for (const provider of [ctx?.channel, ctx?.channelId, event?.channelId, event?.channel]) {
          if (!optionalExact(provider, 'telegram')) return null;
        }
        if (ctx?.trigger !== 'user' || !optionalExact(event?.trigger, 'user')) return null;
        if (event?.senderIsOwner !== true) return null;
        if (boundedContextValue([ctx?.sessionKey], 512) !== managedMainSessionKey) return null;
        if (!optionalExact(event?.sessionKey, managedMainSessionKey)) return null;

        const eventSenderId = exactTelegramId(event?.senderId);
        const contextSenderId = exactTelegramId(ctx?.senderId);
        const channelSenderId = exactTelegramId(ctx?.channelContext?.sender?.id);
        if (
          !eventSenderId
          || eventSenderId !== contextSenderId
          || eventSenderId !== channelSenderId
          || promptDigest(eventSenderId) !== config.managedTelegramOwnerDigest
        ) return null;

        const chatId = exactTelegramId(ctx?.channelContext?.chat?.id);
        if (!chatId || chatId !== eventSenderId) return null;
        for (const conversationId of [
          ctx?.chatId,
          ctx?.conversationId,
          event?.chatId,
          event?.conversationId
        ]) {
          if (!optionalExact(conversationId, chatId, exactTelegramId)) return null;
        }

        const accountId = exactAccountId(event?.accountId);
        if (!accountId || !optionalExact(ctx?.accountId, accountId, exactAccountId)) return null;
        if (
          promptDigest(`telegram:v1:${accountId}:${eventSenderId}:${chatId}`)
          !== config.managedTelegramBindingDigest
        ) return null;

        const contextRunId = runIdFrom(ctx);
        const eventRunId = runIdFrom(event);
        if (!contextRunId) return null;
        if (Object.hasOwn(event ?? {}, 'runId') && !eventRunId) return null;
        if (eventRunId && eventRunId !== contextRunId) return null;

        return Object.freeze({
          accountId,
          conversationId: chatId,
          runId: contextRunId,
          senderId: eventSenderId,
          sessionKey: managedMainSessionKey
        });
      };

      const stopHeartbeat = (state) => {
        if (!state?.heartbeat) return;
        cancelInterval(state.heartbeat);
        state.heartbeat = null;
      };

      const stopDeliveryReceiptTimer = (state) => {
        if (!state?.deliveryReceiptTimer) return;
        cancelTimeout(state.deliveryReceiptTimer);
        state.deliveryReceiptTimer = null;
      };

      const armDeliveryReceiptTimer = (state) => {
        if (state.status !== 'settled' || state.deliveryReceiptTimer || !state.responseDigest) return;
        state.deliveryReceiptTimer = scheduleTimeout(() => {
          state.deliveryReceiptTimer = null;
          if (state.status !== 'settled' || !state.responseDigest) return;
          void callGateway('thread-delivery', {
            inboundId: state.claim.inboundId,
            jobId: state.claim.jobId,
            responseDigest: state.responseDigest,
            success: false,
            messageId: null
          }).catch(() => undefined).finally(() => {
            if (state.status === 'settled') state.status = 'delivery_reconcile_required';
          });
        }, DELIVERY_RECEIPT_TIMEOUT_MS);
        state.deliveryReceiptTimer?.unref?.();
      };

      const deleteRunState = (runId, expectedState) => {
        const state = runStates.get(runId);
        if (!state || (expectedState && state !== expectedState)) return;
        stopHeartbeat(state);
        stopDeliveryReceiptTimer(state);
        for (const [candidateRunId, candidateState] of runStates) {
          if (candidateState !== state) continue;
          runStates.delete(candidateRunId);
          inboundStates.delete(candidateRunId);
        }
      };

      const invalidateRunState = (runId, state, reason) => {
        if (runStates.get(runId) !== state) return;
        stopHeartbeat(state);
        state.status = reason;
        state.invalidatedAt = now();
      };

      const pruneStates = () => {
        const cutoff = now() - MAX_RUN_AGE_MS;
        for (const [runId, state] of runStates) {
          if (state.createdAt < cutoff) deleteRunState(runId, state);
        }
        for (const [runId, state] of inboundStates) {
          if (state.createdAt < cutoff) inboundStates.delete(runId);
        }
        for (const [inboundId, state] of recoveryClaims) {
          if (state.createdAt < cutoff) recoveryClaims.delete(inboundId);
        }
      };

      const modelDefaults = () => ({
        providerOverride: config.modelProvider,
        modelOverride: config.model
      });

      const requireRunId = (event, ctx) => {
        const eventRunId = runIdFrom(event);
        const contextRunId = runIdFrom(ctx);
        if (eventRunId && contextRunId && eventRunId !== contextRunId) {
          throw new Error('managed_kimi_run_id_conflict');
        }
        const runId = contextRunId || eventRunId;
        if (!runId) throw new Error('managed_kimi_run_id_required');
        return runId;
      };

      const findOutboundState = (event, ctx) => {
        const exactRunId = runIdFrom(event, ctx);
        if (exactRunId && runStates.has(exactRunId)) {
          return { runId: exactRunId, state: runStates.get(exactRunId) };
        }
        const sessionKey = boundedContextValue([event?.sessionKey, ctx?.sessionKey], 512);
        const states = [...new Set([...runStates.values()].filter((state) => (
          !sessionKey
          || state.sessionKey === sessionKey
          || state.sessionKeys?.has(sessionKey)
        )))];
        if (states.length === 1) {
          const state = states[0];
          return { runId: state.activeRunId, state };
        }
        const outboundDigest = responseDigest(event?.content);
        if (!outboundDigest) return null;
        const digestMatches = states.filter((state) => (
          ['settled', 'delivered'].includes(state.status)
          && state.responseDigest === outboundDigest
        ));
        if (digestMatches.length !== 1) return null;
        const state = digestMatches[0];
        return { runId: state.activeRunId, state };
      };

      const isManagedOutboundSession = (event, ctx) => {
        const sessionKey = boundedContextValue([event?.sessionKey, ctx?.sessionKey], 512);
        return sessionKey.startsWith(`agent:${config.managedAgentId}:`);
      };

      const activateClaim = (runId, claim) => {
        const state = {
          status: 'claimed',
          claim,
          sessionKey: claim.sessionKey,
          sessionKeys: new Set([claim.sessionKey]),
          originSessionKey: claim.sessionKey,
          promptDigest: claim.promptDigest,
          originRunId: runId,
          activeRunId: runId,
          createdAt: now(),
          heartbeat: null,
          deliveryReceiptTimer: null
        };
        const heartbeat = scheduleInterval(() => {
          if (runStates.get(runId) !== state || state.status !== 'claimed') return;
          void callGateway('thread-renew', {
            claimToken: claim.claimToken,
            claimOwner: claim.claimOwner,
            jobId: claim.jobId
          }).catch(() => invalidateRunState(runId, state, 'renewal_failed'));
        }, CLAIM_RENEW_INTERVAL_MS);
        heartbeat?.unref?.();
        state.heartbeat = heartbeat;
        runStates.set(runId, state);
        return state;
      };

      const buildManagedKimiRunFallback = (event, ctx, runId) => {
        const detectedChannel = sourceChannel(event, ctx);
        const explicitProviders = boundedContextValues(
          [event?.channelId, event?.channel, ctx?.messageProvider, ctx?.channel],
          128
        );
        const authenticatedOwnerWithoutIdentity = detectedChannel === 'WEB'
          && explicitProviders.length === 0
          && event?.senderIsOwner === true;
        const authenticatedManagedMain = isAuthenticatedManagedMainRun(event, ctx);
        const telegramProof = telegramOwnerProof(event, ctx);
        if (
          detectedChannel !== 'KIMI'
          && !authenticatedOwnerWithoutIdentity
          && !authenticatedManagedMain
          && !telegramProof
        ) {
          return null;
        }
        const configuredProvider = config.managedOwnerIdentity.slice(0, ownerSeparator);
        const configuredPrincipal = configuredOwnerPrincipal;
        const sessionKey = boundedContextValue([ctx?.sessionKey], 512);
        const conversationId = boundedContextValue(
          [telegramProof?.conversationId, ctx?.chatId, ctx?.channelId, event?.channelId, sessionKey],
          512
        );
        return {
          externalMessageId: `openclaw-run:${runId}`,
          sessionKey,
          conversationId,
          senderId: boundedContextValue(
            [
              telegramProof?.senderId,
              event?.senderId,
              ctx?.senderId,
              authenticatedOwnerWithoutIdentity || authenticatedManagedMain ? configuredPrincipal : ''
            ],
            256
          ),
          accountId: boundedContextValue(
            [telegramProof?.accountId, event?.accountId, ctx?.accountId, authenticatedOwnerWithoutIdentity ? configuredPrincipal : ''],
            256
          ),
          provider: boundedContextValue(
            [
              event?.channelId,
              ctx?.messageProvider,
              ctx?.channel,
              telegramProof ? 'telegram' : '',
              authenticatedOwnerWithoutIdentity || authenticatedManagedMain ? configuredProvider : ''
            ],
            128
          ).toLowerCase(),
          channel: telegramProof ? 'TELEGRAM' : 'KIMI',
          correlationSource: telegramProof
            ? 'before_agent_run_telegram_owner'
            : authenticatedOwnerWithoutIdentity
            ? 'before_agent_run_owner_verdict'
            : authenticatedManagedMain
              ? 'before_agent_run_managed_main'
            : 'before_agent_run',
          createdAt: now()
        };
      };

      const claimNormalRun = async (event, ctx, runId) => {
        const inbound = inboundStates.get(runId) ?? buildManagedKimiRunFallback(event, ctx, runId);
        if (!inbound) throw new Error('managed_kimi_inbound_hooks_not_emitted');
        if (!inboundStates.has(runId)) inboundStates.set(runId, inbound);
        if (inbound.correlationConflict) throw new Error('managed_kimi_inbound_correlation_conflict');
        const providers = boundedContextValues(
          [event?.channelId, event?.channel, ctx?.messageProvider, ctx?.channel, inbound.provider],
          128
        );
        const principals = boundedContextValues([
          event?.senderId,
          ctx?.senderId,
          inbound.senderId,
          event?.accountId,
          ctx?.accountId,
          inbound.accountId
        ], 256);
        const managedPrincipal = matchedManagedPrincipal(
          config.managedOwnerIdentity,
          providers,
          principals
        );
        const authenticatedManagedMain = isAuthenticatedManagedMainRun(event, ctx);
        const telegramProof = inbound.correlationSource === 'before_agent_run_telegram_owner'
          ? telegramOwnerProof(event, ctx)
          : null;
        const senderId = telegramProof?.senderId
          || managedPrincipal
          || (authenticatedManagedMain ? configuredOwnerPrincipal : principals[0])
          || '';
        const channel = inbound.correlationSource === 'message_received' && inbound.channel === 'WEB'
          ? sourceChannel(event, ctx)
          : inbound.channel;
        const ownerVerified = channel === 'TELEGRAM'
          ? inbound.correlationSource === 'before_agent_run_telegram_owner'
            ? Boolean(telegramProof)
            : event?.senderIsOwner === true
          : event?.senderIsOwner === true
            || (channel === 'KIMI' && Boolean(managedPrincipal))
            || authenticatedManagedMain;
        if (!ownerVerified) {
          throw new Error(ownerProofFailure(config.managedOwnerIdentity, providers, principals));
        }
        if (!inbound.externalMessageId || !inbound.sessionKey || !inbound.conversationId || !senderId) {
          throw new Error('managed_kimi_inbound_correlation_required');
        }
        const text = normalizedOwnerPrompt(event?.prompt);
        if (!text) throw new Error('managed_kimi_prompt_required');
        const claimOwner = `openclaw-run:${runId}`;
        const result = await callGateway('intake', {
          channel,
          externalMessageId: inbound.externalMessageId,
          conversationId: inbound.conversationId,
          sessionKey: inbound.sessionKey,
          senderId,
          claimOwner,
          timestamp: now(),
          text
        });
        return Object.freeze({
          ...validateClaim(result),
          claimOwner,
          sessionKey: inbound.sessionKey,
          promptDigest: promptDigest(text)
        });
      };

      const claimRecoveryRun = async (event, ctx, runId, packet) => {
        const pending = recoveryClaims.get(packet.inboundId);
        if (
          !pending
          || pending.nonce !== packet.nonce
          || pending.assignment.objectiveId !== packet.objectiveId
          || pending.assignment.threadId !== packet.threadId
          || pending.assignment.jobId !== packet.jobId
        ) throw new Error('managed_kimi_recovery_claim_missing');
        const claimOwner = `openclaw-run:${runId}`;
        const result = await callGateway('thread-transfer', {
          inboundId: pending.assignment.inboundId,
          claimToken: pending.assignment.claimToken,
          claimOwner: pending.claimOwner,
          newClaimOwner: claimOwner
        });
        const assignment = validateRecoveryAssignment(result);
        if (assignment.inboundId !== pending.assignment.inboundId) {
          throw new Error('managed_kimi_recovery_transfer_mismatch');
        }
        recoveryClaims.delete(packet.inboundId);
        return Object.freeze({
          inboundId: assignment.inboundId,
          claimToken: assignment.claimToken,
          jobId: assignment.jobId,
          threadId: assignment.threadId,
          objectiveId: assignment.objectiveId,
          claimOwner,
          sessionKey: assignment.sessionKey,
          promptDigest: promptDigest(event?.prompt)
        });
      };

      const joinManagedContinuation = async (event, ctx, runId) => {
        const sessionKey = boundedContextValue([ctx?.sessionKey], 512);
        if (sessionKey !== managedMainSessionKey) return null;
        if (event?.senderIsOwner !== false) return null;
        if (!normalizedString(event?.accountId)) return null;
        if (normalizedString(event?.senderId) || normalizedString(ctx?.senderId)) return null;
        const normalizedPrompt = normalizedOwnerPrompt(event?.prompt);
        const digest = promptDigest(normalizedPrompt);
        if (!digest) return null;
        const cutoff = now() - MANAGED_CONTINUATION_MAX_AGE_MS;
        const baseCandidates = [...new Set(runStates.values())].filter((state) => (
          state.status === 'claimed'
          && state.originSessionKey === managedBootSessionKey
          && state.activeRunId === state.originRunId
          && state.createdAt >= cutoff
        ));
        const candidates = baseCandidates.filter((state) => state.promptDigest === digest);
        if (candidates.length === 1) {
          const state = candidates[0];
          state.activeRunId = runId;
          state.sessionKey = sessionKey;
          state.sessionKeys.add(sessionKey);
          state.continuationJoinedAt = now();
          runStates.set(runId, state);
          return state;
        }

        const result = await callGateway('continuation', {
          claimOwner: `openclaw-run:${runId}`,
          text: normalizedPrompt,
          bootConversationId: managedBootSessionKey,
          mainSessionKey: managedMainSessionKey
        });
        if (result?.assignment) {
          const assignment = validateRecoveryAssignment(result);
          if (
            assignment.sessionKey !== managedMainSessionKey
            || assignment.channel !== 'KIMI'
            || assignment.conversationId !== managedBootSessionKey
          ) throw new Error('managed_kimi_continuation_assignment_mismatch');
          return activateClaim(runId, Object.freeze({
            inboundId: assignment.inboundId,
            claimToken: assignment.claimToken,
            jobId: assignment.jobId,
            threadId: assignment.threadId,
            objectiveId: assignment.objectiveId,
            claimOwner: `openclaw-run:${runId}`,
            sessionKey: managedMainSessionKey,
            promptDigest: digest
          }));
        }
        if (!continuationDiagnosticLogged) {
          api.logger?.warn?.(
            `Brad managed continuation not joined: candidate_count=${baseCandidates.length} prompt_match=${baseCandidates.some((state) => state.promptDigest === digest)}`
          );
          continuationDiagnosticLogged = true;
        }
        return null;
      };

      const claimRun = async (event, ctx) => {
        pruneStates();
        const runId = requireRunId(event, ctx);
        const existing = runStates.get(runId);
        if (existing?.status === 'claimed') return existing;
        if (existing?.status === 'claiming') return existing.promise;
        if (existing) throw new Error('managed_kimi_run_not_claimable');

        const continuation = await joinManagedContinuation(event, ctx, runId);
        if (continuation) return continuation;

        const packet = parseRecoveryPacket(event?.prompt);
        const sessionKey = packet
          ? recoveryClaims.get(packet.inboundId)?.assignment.sessionKey
          : inboundStates.get(runId)?.sessionKey ?? boundedContextValue([ctx?.sessionKey], 512);
        const promise = Promise.resolve()
          .then(() => packet
            ? claimRecoveryRun(event, ctx, runId, packet)
            : claimNormalRun(event, ctx, runId))
          .then((claim) => activateClaim(runId, claim));
        const claimingState = {
          status: 'claiming',
          promise,
          sessionKey,
          sessionKeys: new Set([sessionKey]),
          originSessionKey: sessionKey,
          promptDigest: promptDigest(event?.prompt),
          originRunId: runId,
          activeRunId: runId,
          createdAt: now(),
          heartbeat: null
        };
        runStates.set(runId, claimingState);

        try {
          return await promise;
        } catch (error) {
          if (runStates.get(runId) === claimingState) {
            runStates.set(runId, { status: 'rejected', sessionKey, createdAt: now(), heartbeat: null });
          }
          throw error;
        }
      };

      const settleRun = async (event, ctx) => {
        pruneStates();
        if (!isManagedBradRun(ctx, config)) return;
        const runId = runIdFrom(ctx, event);
        if (!runId) return;
        const state = runStates.get(runId);
        if (!state || state.status === 'settled' || state.status === 'settling') return;
        if (state.status !== 'claimed') return;
        if (state.activeRunId !== runId) return;
        const text = assistantText(event);
        if (!text) {
          invalidateRunState(runId, state, 'settlement_failed');
          return;
        }

        stopHeartbeat(state);
        state.status = 'settling';
        try {
          const result = await callGateway('thread-reply', {
            claimToken: state.claim.claimToken,
            jobId: state.claim.jobId,
            threadId: state.claim.threadId,
            objectiveId: state.claim.objectiveId,
            claimOwner: state.claim.claimOwner,
            sessionId: ctx.sessionId || ctx.sessionKey || null,
            text
          });
          state.responseDigest = claimField(result, 'responseDigest', 64);
          state.status = 'settled';
          state.settledAt = now();
          armDeliveryReceiptTimer(state);
        } catch {
          state.status = 'settlement_failed';
          state.invalidatedAt = now();
        }
      };

      const recoverStalled = async () => {
        if (!config.recoveryEnabled || recoveryScanActive) return;
        recoveryScanActive = true;
        try {
          pruneStates();
          for (let count = 0; count < MAX_RECOVERIES_PER_SCAN; count += 1) {
            const result = await callGateway('recover', { claimOwner: recoveryOwner });
            if (!result?.assignment) break;
            const assignment = validateRecoveryAssignment(result);
            const nonce = randomId();
            recoveryClaims.set(assignment.inboundId, {
              assignment,
              claimOwner: recoveryOwner,
              nonce,
              createdAt: now()
            });
            try {
              await scheduleSessionTurn.call(api.session.workflow, {
                sessionKey: assignment.sessionKey,
                message: buildRecoveryPacket(assignment, nonce),
                agentId: config.managedAgentId,
                delayMs: 0,
                deleteAfterRun: true,
                deliveryMode: 'announce',
                tag: `brad-recovery:${assignment.inboundId}`
              });
            } catch {
              recoveryClaims.delete(assignment.inboundId);
              break;
            }
          }
        } catch (error) {
          api.logger?.warn?.(`Brad recovery scan failed: ${error instanceof Error ? error.message : 'unknown_error'}`);
        } finally {
          recoveryScanActive = false;
        }
      };

      const rememberInbound = (event, ctx, correlationSource) => {
        pruneStates();
        const runId = runIdFrom(event, ctx);
        if (!runId) return;
        if (ctx?.agentId && normalizedString(ctx.agentId) !== config.managedAgentId) return;
        const externalMessageId = boundedContextValue([event?.messageId, ctx?.messageId], 256);
        const sessionKey = boundedContextValue([event?.sessionKey, ctx?.sessionKey], 512);
        const conversationId = boundedContextValue(
          [event?.conversationId, ctx?.conversationId, ctx?.chatId, ctx?.channelId, sessionKey],
          512
        );
        const senderId = boundedContextValue([event?.senderId, ctx?.senderId], 256);
        const accountId = boundedContextValue([event?.accountId, ctx?.accountId], 256);
        const provider = boundedContextValue(
          [event?.channelId, event?.channel, ctx?.messageProvider, ctx?.channel],
          128
        ).toLowerCase();
        const next = {
          externalMessageId,
          sessionKey,
          conversationId,
          senderId,
          accountId,
          provider,
          channel: sourceChannel(event, ctx),
          correlationSource,
          createdAt: now()
        };
        const existing = inboundStates.get(runId);
        if (!existing) {
          inboundStates.set(runId, next);
          return;
        }
        const externalMessageConflict = existing.externalMessageId
          && next.externalMessageId
          && existing.externalMessageId !== next.externalMessageId;
        const sessionConflict = existing.sessionKey
          && next.sessionKey
          && existing.sessionKey !== next.sessionKey;
        inboundStates.set(runId, {
          externalMessageId: existing.externalMessageId || next.externalMessageId,
          sessionKey: existing.sessionKey || next.sessionKey,
          conversationId: existing.conversationId || next.conversationId,
          senderId: existing.senderId || next.senderId,
          accountId: existing.accountId || next.accountId,
          provider: existing.provider || next.provider,
          channel: existing.channel !== 'WEB' ? existing.channel : next.channel,
          correlationSource: existing.correlationSource === 'inbound_claim'
            || next.correlationSource === 'inbound_claim'
            ? 'inbound_claim'
            : 'message_received',
          correlationConflict: existing.correlationConflict || externalMessageConflict || sessionConflict,
          createdAt: Math.min(existing.createdAt, next.createdAt)
        });
      };

      api.on('inbound_claim', async (event, ctx) => {
        rememberInbound(event, ctx, 'inbound_claim');
      }, { priority: 100 });

      api.on('message_received', async (event, ctx) => {
        rememberInbound(event, ctx, 'message_received');
      }, { priority: 100 });

      api.on('before_model_resolve', async (event, ctx) => {
        if (!isManagedBradRun(ctx, config)) return;
        return modelDefaults();
      }, { priority: 100 });

      api.on('before_prompt_build', async (event, ctx) => {
        if (!isManagedBradRun(ctx, config)) return;
        return { prependSystemContext: BRAD_EXECUTIVE_SYSTEM_CONTEXT };
      }, { priority: 100 });

      api.on('before_agent_run', async (event, ctx) => {
        if (!isManagedBradRun(ctx, config)) return;
        try {
          await claimRun(event, ctx);
          return;
        } catch (error) {
          api.logger?.warn?.(`Brad managed intake blocked: ${safeClaimFailureCode(error)}`);
          if (!ownerContextShapeLogged) {
            api.logger?.warn?.(`Brad managed owner context shape: ${safeOwnerContextShape(event, ctx, config)}`);
            ownerContextShapeLogged = true;
          }
          return {
            outcome: 'block',
            reason: 'Brad intake was not durably claimed for an authenticated owner before model execution.',
            message: 'Brad could not safely record this task. Please retry shortly.'
          };
        }
      }, { priority: 100 });

      api.on('before_agent_finalize', async (event, ctx) => {
        await settleRun(event, ctx);
      }, { priority: 100 });

      api.on('reply_payload_sending', async (event, ctx) => {
        if (normalizedString(event?.kind).toLowerCase() !== 'final') return;
        const matched = findOutboundState(event, ctx);
        if (!matched && !isManagedOutboundSession(event, ctx)) return;
        if (matched?.state?.status === 'settled') {
          armDeliveryReceiptTimer(matched.state);
          return;
        }
        if (matched?.state?.status === 'delivered') return;
        return {
          cancel: true,
          reason: 'Brad blocked an answer that was not durably settled in the control plane.'
        };
      }, { priority: 100 });

      api.on('agent_end', async (event, ctx) => {
        pruneStates();
        if (!isManagedBradRun(ctx, config)) return;
        const runId = runIdFrom(event, ctx);
        if (!runId) return;
        const state = runStates.get(runId);
        if (!state) return;
        if (state.activeRunId !== runId) return;
        if (!event?.success && !['settled', 'delivered', 'delivery_reconcile_required'].includes(state.status)) {
          invalidateRunState(runId, state, 'run_failed');
        }
      }, { priority: 90 });

      api.on('message_sent', async (event, ctx) => {
        const matched = findOutboundState(event, ctx);
        if (!matched) return;
        const { runId, state } = matched;
        if (state.status === 'delivered') return;
        if (state.status !== 'settled' || !state.responseDigest) return;
        stopDeliveryReceiptTimer(state);
        try {
          await callGateway('thread-delivery', {
            inboundId: state.claim.inboundId,
            jobId: state.claim.jobId,
            responseDigest: state.responseDigest,
            success: event?.success === true,
            messageId: boundedContextValue([event?.messageId], 512) || null
          });
          if (event?.success === true) {
            state.status = 'delivered';
            state.deliveredAt = now();
            return;
          }
        } catch {
          // A missing receipt is itself ambiguous; hold the run for reconciliation.
        }
        state.status = 'delivery_reconcile_required';
      }, { priority: 100 });

      api.on('before_tool_call', async (event, ctx) => {
        pruneStates();
        if (normalizedString(ctx?.agentId) !== config.managedAgentId) return;
        const runId = runIdFrom(ctx, event);
        const state = runId ? runStates.get(runId) : null;
        if (state?.status === 'claimed' && event.toolName === 'exec' && commandAllowed(event.params)) return;
        return {
          block: true,
          blockReason: state?.status === 'claimed'
            ? 'Brad delegates tools through the approval-gated control plane.'
            : 'Brad has no valid durable claim for this tool call.'
        };
      }, { priority: 100 });

      api.on('gateway_start', async () => {
        if (!config.recoveryEnabled) return;
        await recoverStalled();
        recoveryTimer = scheduleInterval(() => {
          void recoverStalled();
        }, RECOVERY_SCAN_INTERVAL_MS);
        recoveryTimer?.unref?.();
      }, { priority: 100 });

      api.on('gateway_stop', () => {
        if (recoveryTimer) {
          cancelInterval(recoveryTimer);
          recoveryTimer = null;
        }
        for (const [runId, state] of runStates) deleteRunState(runId, state);
        inboundStates.clear();
        recoveryClaims.clear();
      }, { priority: 100 });
    }
  };
}

export default createManagedKimiPlugin();
