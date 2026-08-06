import assert from 'node:assert/strict';
import test from 'node:test';

import { createManagedKimiPlugin } from '../index.js';

const CONFIG = {
  managedAgentId: 'brad-runtime',
  modelProvider: 'kimi-coding',
  model: 'k2p6',
  recoveryEnabled: false
};

const FORCED_SSH_PREFIX = '/usr/bin/ssh -i /root/.ssh/id_ed25519_brad_gateway -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 benjijmac@35.188.189.202 ';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeApi(pluginConfig, scheduleSessionTurn = async () => undefined) {
  const resolvedConfig = arguments.length === 0 ? CONFIG : pluginConfig;
  const handlers = new Map();
  return {
    pluginConfig: resolvedConfig,
    handlers,
    logger: { warn() {} },
    session: { workflow: { scheduleSessionTurn } },
    on(name, handler) {
      assert.equal(handlers.has(name), false, `duplicate hook ${name}`);
      handlers.set(name, handler);
    }
  };
}

function kimiContext(runId, overrides = {}) {
  return {
    runId,
    agentId: CONFIG.managedAgentId,
    messageProvider: 'kimi-claw',
    channel: 'kimi-claw',
    channelId: 'conversation-1',
    chatId: 'conversation-1',
    conversationId: 'conversation-1',
    messageId: `provider-message-${runId}`,
    senderId: 'owner-1',
    sessionId: `session-${runId}`,
    sessionKey: `agent:${CONFIG.managedAgentId}:kimi-claw:direct:conversation-1`,
    trigger: 'user',
    ...overrides
  };
}

function runEvent(prompt, overrides = {}) {
  return {
    prompt,
    messages: [],
    channelId: 'kimi-claw',
    senderId: 'owner-1',
    senderIsOwner: true,
    ...overrides
  };
}

function inboundEvent(overrides = {}) {
  return { content: 'owner message', messages: [], success: true, ...overrides };
}

function claim(runId) {
  const id = runId.replace(/^provider-message-/, '');
  return {
    ok: true,
    settled: false,
    inboundId: `inbound-${id}`,
    claimToken: `claim-${id}`,
    jobId: `job-${id}`,
    threadId: `thread-${id}`,
    objectiveId: `objective-${id}`
  };
}

function gatewayOk(operation) {
  return operation === 'thread-reply'
    ? { ok: true, responseDigest: 'a'.repeat(64) }
    : { ok: true };
}

async function claimNormal(api, runId, prompt = `objective ${runId}`, inboundOverrides = {}, ctxOverrides = {}) {
  const ctx = kimiContext(runId, { ...inboundOverrides, ...ctxOverrides });
  await api.handlers.get('inbound_claim')(inboundEvent(), ctx);
  const result = await api.handlers.get('before_agent_run')(runEvent(prompt), ctx);
  return { ctx, result };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('concurrent runs settle against their exact provider message and claim before final delivery', async () => {
  const intakeA = deferred();
  const intakeB = deferred();
  const calls = [];
  const gateway = async (operation, payload) => {
    calls.push({ operation, payload });
    if (operation === 'intake') {
      return payload.externalMessageId === 'provider-a' ? intakeA.promise : intakeB.promise;
    }
    return gatewayOk(operation);
  };
  const api = fakeApi();
  createManagedKimiPlugin({ gateway, now: () => 1_000 }).register(api);

  assert.deepEqual(
    await api.handlers.get('before_model_resolve')({}, kimiContext('run-a')),
    { providerOverride: 'kimi-coding', modelOverride: 'k2p6' }
  );
  assert.match(
    (await api.handlers.get('before_prompt_build')({}, kimiContext('run-a'))).prependSystemContext,
    /Kimi-powered executive identity/
  );

  await api.handlers.get('inbound_claim')(
    inboundEvent(),
    kimiContext('run-a', { messageId: 'provider-a' })
  );
  await api.handlers.get('inbound_claim')(
    inboundEvent(),
    kimiContext('run-b', { messageId: 'provider-b' })
  );
  const startA = api.handlers.get('before_agent_run')(runEvent('objective A'), kimiContext('run-a'));
  const startB = api.handlers.get('before_agent_run')(runEvent('objective B'), kimiContext('run-b'));

  intakeB.resolve(claim('run-b'));
  assert.equal(await startB, undefined);
  intakeA.resolve(claim('run-a'));
  assert.equal(await startA, undefined);

  await Promise.all([
    api.handlers.get('before_agent_finalize')(
      { lastAssistantMessage: { role: 'assistant', content: 'reply A' } },
      kimiContext('run-a')
    ),
    api.handlers.get('before_agent_finalize')(
      { lastAssistantMessage: { role: 'assistant', content: 'reply B' } },
      kimiContext('run-b')
    )
  ]);

  const replies = calls.filter((call) => call.operation === 'thread-reply');
  assert.equal(replies.length, 2);
  assert.deepEqual(
    replies.map(({ payload }) => [payload.claimToken, payload.claimOwner, payload.jobId, payload.text]).sort(),
    [
      ['claim-run-a', 'openclaw-run:run-a', 'job-run-a', 'reply A'],
      ['claim-run-b', 'openclaw-run:run-b', 'job-run-b', 'reply B']
    ]
  );
  assert.equal(
    await api.handlers.get('reply_payload_sending')({ kind: 'final', runId: 'run-a' }, kimiContext('run-a')),
    undefined
  );
  await api.handlers.get('message_sent')(
    { runId: 'run-a', success: true, messageId: 'provider-response-a' },
    kimiContext('run-a')
  );
  assert.deepEqual(calls.find((call) => call.operation === 'thread-delivery')?.payload, {
    inboundId: 'inbound-run-a',
    jobId: 'job-run-a',
    responseDigest: 'a'.repeat(64),
    success: true,
    messageId: 'provider-response-a'
  });
});

test('provider message id, not run id, is the durable dedupe identity', async () => {
  const calls = [];
  let count = 0;
  const gateway = async (operation, payload) => {
    calls.push({ operation, payload });
    if (operation !== 'intake') return gatewayOk(operation);
    count += 1;
    if (count === 1) return claim('first-run');
    return {
      ok: true,
      settled: true,
      inboundId: 'inbound-first-run',
      jobId: 'job-first-run',
      threadId: 'thread-first-run',
      objectiveId: 'objective-first-run'
    };
  };
  const api = fakeApi();
  createManagedKimiPlugin({ gateway }).register(api);

  await claimNormal(api, 'first-run', 'same objective', { messageId: 'provider-stable-id' });
  await api.handlers.get('before_agent_finalize')(
    { lastAssistantMessage: { role: 'assistant', content: 'settled once' } },
    kimiContext('first-run')
  );
  const second = await claimNormal(api, 'second-run', 'same objective', { messageId: 'provider-stable-id' });
  assert.equal(second.result.outcome, 'block');
  assert.deepEqual(
    calls.filter((call) => call.operation === 'intake').map((call) => call.payload.externalMessageId),
    ['provider-stable-id', 'provider-stable-id']
  );
});

test('owner proof from before_agent_run joins inbound correlation before intake', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      return operation === 'intake' ? claim(payload.externalMessageId) : gatewayOk(operation);
    }
  }).register(api);

  const ctx = kimiContext('official-hook-contract', {
    messageId: 'provider-official-hook-contract',
    senderId: 'owner-from-claim-context'
  });
  await api.handlers.get('inbound_claim')(inboundEvent(), ctx);
  const result = await api.handlers.get('before_agent_run')(
    runEvent('official hook contract', { senderId: 'owner-from-agent-run', senderIsOwner: true }),
    ctx
  );

  assert.equal(result, undefined);
  assert.equal(calls[0].operation, 'intake');
  assert.equal(calls[0].payload.externalMessageId, 'provider-official-hook-contract');
  assert.equal(calls[0].payload.senderId, 'owner-from-agent-run');
});

test('unknown or non-owner execution signals fail closed before intake', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      return claim(payload.externalMessageId);
    }
  }).register(api);

  for (const [runId, senderIsOwner] of [['unknown-owner', undefined], ['non-owner', false]]) {
    const ctx = kimiContext(runId);
    await api.handlers.get('inbound_claim')(inboundEvent(), ctx);
    const event = runEvent('must not run');
    if (senderIsOwner === undefined) delete event.senderIsOwner;
    else event.senderIsOwner = senderIsOwner;
    const result = await api.handlers.get('before_agent_run')(event, ctx);
    assert.equal(result.outcome, 'block');
  }
  assert.deepEqual(calls, []);
});

test('missing provider message id or session key fails closed', async () => {
  const api = fakeApi();
  createManagedKimiPlugin({ gateway: async () => claim('should-not-happen') }).register(api);
  const event = inboundEvent();
  await api.handlers.get('inbound_claim')(
    event,
    kimiContext('missing-correlation', { sessionKey: '', messageId: '' })
  );
  const result = await api.handlers.get('before_agent_run')(
    runEvent('must not run'),
    kimiContext('missing-correlation', { sessionKey: '' })
  );
  assert.equal(result.outcome, 'block');
});

test('all managed tools fail closed unless the exact run has a live claim', async () => {
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => operation === 'intake' ? claim(payload.externalMessageId) : gatewayOk(operation)
  }).register(api);
  const beforeToolCall = api.handlers.get('before_tool_call');

  assert.deepEqual(
    await beforeToolCall({ toolName: 'read', params: {} }, kimiContext('unclaimed')),
    { block: true, blockReason: 'Brad has no valid durable claim for this tool call.' }
  );
  assert.equal(
    await beforeToolCall({ toolName: 'read', params: {} }, kimiContext('other', { agentId: 'other-agent' })),
    undefined
  );

  await claimNormal(api, 'claimed');
  assert.equal(
    await beforeToolCall(
      { toolName: 'exec', params: { command: `${FORCED_SSH_PREFIX}thread-status 123e4567-e89b-12d3-a456-426614174000` } },
      kimiContext('claimed')
    ),
    undefined
  );
  assert.deepEqual(
    await beforeToolCall({ toolName: 'read', params: {} }, kimiContext('claimed')),
    { block: true, blockReason: 'Brad delegates tools through the approval-gated control plane.' }
  );
});

test('claim renewal failure invalidates the run and cancels its final answer', async () => {
  const scheduled = [];
  const cancelled = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      if (operation === 'intake') return claim(payload.externalMessageId);
      if (operation === 'thread-renew') throw new Error('lease lost');
      return gatewayOk(operation);
    },
    setInterval: (handler, delay) => {
      const timer = { handler, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearInterval: (timer) => cancelled.push(timer)
  }).register(api);

  await claimNormal(api, 'renewal-failure');
  assert.equal(scheduled[0].delay, 60_000);
  scheduled[0].handler();
  await flushPromises();
  await api.handlers.get('before_agent_finalize')(
    { lastAssistantMessage: { role: 'assistant', content: 'must not leave' } },
    kimiContext('renewal-failure')
  );
  assert.deepEqual(
    await api.handlers.get('reply_payload_sending')(
      { kind: 'final', runId: 'renewal-failure' },
      kimiContext('renewal-failure')
    ),
    {
      cancel: true,
      reason: 'Brad blocked an answer that was not durably settled in the control plane.'
    }
  );
  assert.deepEqual(cancelled, [scheduled[0]]);
});

test('settlement completes before delivery and settlement failure suppresses output', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      if (operation === 'intake') return claim(payload.externalMessageId);
      if (operation === 'thread-reply' && payload.jobId === 'job-bad-settle') throw new Error('db unavailable');
      return gatewayOk(operation);
    }
  }).register(api);

  await claimNormal(api, 'good-settle');
  await api.handlers.get('before_agent_finalize')(
    { lastAssistantMessage: { role: 'assistant', content: 'durably settled' } },
    kimiContext('good-settle')
  );
  assert.equal(calls.at(-1).operation, 'thread-reply');
  assert.equal(
    await api.handlers.get('reply_payload_sending')({ kind: 'final' }, kimiContext('good-settle')),
    undefined
  );

  await claimNormal(api, 'bad-settle');
  await api.handlers.get('before_agent_finalize')(
    { lastAssistantMessage: { role: 'assistant', content: 'not durably settled' } },
    kimiContext('bad-settle')
  );
  assert.equal(
    (await api.handlers.get('reply_payload_sending')({ kind: 'final' }, kimiContext('bad-settle'))).cancel,
    true
  );

  await api.handlers.get('message_sent')(
    { runId: 'good-settle', success: false, error: 'ambiguous provider failure' },
    kimiContext('good-settle')
  );
  assert.equal(
    (await api.handlers.get('reply_payload_sending')({ kind: 'final' }, kimiContext('good-settle'))).cancel,
    true
  );
});

test('outbound delivery uses the managed session when OpenClaw omits agent and run ids', async () => {
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => operation === 'intake' ? claim(payload.externalMessageId) : gatewayOk(operation)
  }).register(api);
  const { ctx } = await claimNormal(api, 'session-fallback');
  await api.handlers.get('before_agent_finalize')(
    { lastAssistantMessage: 'settled through the exact run' },
    ctx
  );
  const outboundContext = { sessionKey: ctx.sessionKey };
  assert.equal(
    await api.handlers.get('reply_payload_sending')(
      { kind: 'final', sessionKey: ctx.sessionKey },
      outboundContext
    ),
    undefined
  );
  assert.equal(
    (await api.handlers.get('reply_payload_sending')(
      { kind: 'final', sessionKey: `agent:${CONFIG.managedAgentId}:kimi-claw:direct:unclaimed` },
      { sessionKey: `agent:${CONFIG.managedAgentId}:kimi-claw:direct:unclaimed` }
    )).cancel,
    true
  );
});

test('the two-minute recovery scan schedules the original session and transfers its exact claim', async () => {
  const calls = [];
  const scheduledTurns = [];
  const timers = [];
  let recoveryCalls = 0;
  const recovered = {
    inbound_id: 'inbound-recovered',
    claimToken: 'recovery-token',
    job_id: 'job-recovered',
    thread_id: 'thread-recovered',
    objective_id: 'objective-recovered',
    session_key: 'agent:brad-runtime:kimi-claw:direct:conversation-1',
    channel: 'KIMI',
    conversation_id: 'conversation-1',
    goal: 'Recover the objective',
    definition_of_done: 'Verified result or precise blocker',
    verification_method: 'Check the source of truth',
    messages: [{ sender: 'owner', type: 'OWNER_REQUEST', body: 'finish it', sequence: 1 }]
  };
  const api = fakeApi(
    { ...CONFIG, recoveryEnabled: true },
    async (request) => scheduledTurns.push(request)
  );
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      if (operation === 'recover') {
        recoveryCalls += 1;
        return recoveryCalls === 1 ? { ok: true, assignment: recovered } : { ok: true, assignment: null };
      }
      if (operation === 'thread-transfer') {
        return { ok: true, assignment: { ...recovered, claimToken: 'run-token' } };
      }
      return gatewayOk(operation);
    },
    randomUUID: () => 'runtime-1',
    setInterval: (handler, delay) => {
      const timer = { handler, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearInterval() {}
  }).register(api);

  await api.handlers.get('gateway_start')();
  assert.equal(scheduledTurns.length, 1);
  assert.equal(scheduledTurns[0].sessionKey, recovered.session_key);
  assert.equal(scheduledTurns[0].deliveryMode, 'announce');
  assert.equal(timers.some((timer) => timer.delay === 120_000), true);

  const [packetPrefix, encodedPacket] = scheduledTurns[0].message.split(':', 2);
  const spoofedPacket = JSON.parse(Buffer.from(encodedPacket, 'base64url').toString('utf8'));
  spoofedPacket.nonce = 'wrong-nonce';
  const spoofedMessage = `${packetPrefix}:${Buffer.from(JSON.stringify(spoofedPacket), 'utf8').toString('base64url')}`;
  assert.equal(
    (await api.handlers.get('before_agent_run')(
      runEvent(spoofedMessage),
      kimiContext('spoofed-recovery-run', { sessionKey: recovered.session_key })
    )).outcome,
    'block'
  );

  const recoveryCtx = kimiContext('recovery-run', { sessionKey: recovered.session_key });
  assert.equal(
    await api.handlers.get('before_agent_run')(runEvent(scheduledTurns[0].message), recoveryCtx),
    undefined
  );
  const transfer = calls.find((call) => call.operation === 'thread-transfer');
  assert.deepEqual(transfer.payload, {
    inboundId: 'inbound-recovered',
    claimToken: 'recovery-token',
    claimOwner: 'openclaw-recovery:runtime-1',
    newClaimOwner: 'openclaw-run:recovery-run'
  });
  await api.handlers.get('before_agent_finalize')(
    { lastAssistantMessage: { role: 'assistant', content: 'recovered answer' } },
    recoveryCtx
  );
  assert.equal(calls.some((call) => call.operation === 'thread-reply'), true);
  assert.equal(
    await api.handlers.get('reply_payload_sending')({ kind: 'final' }, recoveryCtx),
    undefined
  );
});

test('unrelated agents and cron runs are neither claimed nor model-routed', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      return claim(payload.externalMessageId);
    }
  }).register(api);
  for (const ctx of [
    kimiContext('other-agent', { agentId: 'another-agent' }),
    kimiContext('cron', { trigger: 'cron' })
  ]) {
    assert.equal(await api.handlers.get('before_model_resolve')({}, ctx), undefined);
    assert.equal(await api.handlers.get('before_prompt_build')({}, ctx), undefined);
    assert.equal(await api.handlers.get('before_agent_run')(runEvent('do not claim'), ctx), undefined);
  }
  assert.deepEqual(calls, []);
});

test('Kimi, Telegram, and web inbound messages retain their source channel', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      return operation === 'intake' ? claim(payload.externalMessageId) : gatewayOk(operation);
    }
  }).register(api);

  await claimNormal(api, 'kimi-turn');
  await claimNormal(
    api,
    'telegram-turn',
    'telegram objective',
    { channelId: 'telegram', senderId: 'telegram-owner' },
    { messageProvider: 'telegram', channel: 'telegram' }
  );
  await claimNormal(
    api,
    'web-turn',
    'web objective',
    { channelId: 'browser-chat' },
    { messageProvider: 'webchat', channel: 'webchat' }
  );

  assert.deepEqual(
    calls.filter((call) => call.operation === 'intake').map((call) => call.payload.channel),
    ['KIMI', 'TELEGRAM', 'WEB']
  );
});

test('gateway shutdown cancels claim heartbeats and the recovery scanner', async () => {
  const scheduled = [];
  const cancelled = [];
  let recoveryCalls = 0;
  const api = fakeApi({ ...CONFIG, recoveryEnabled: true });
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      if (operation === 'recover') {
        recoveryCalls += 1;
        return { ok: true, assignment: null };
      }
      return operation === 'intake' ? claim(payload.externalMessageId) : gatewayOk(operation);
    },
    setInterval: (handler, delay) => {
      const timer = { handler, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearInterval: (timer) => cancelled.push(timer)
  }).register(api);

  await claimNormal(api, 'shutdown-a');
  await api.handlers.get('gateway_start')();
  assert.equal(recoveryCalls, 1);
  await api.handlers.get('gateway_stop')();
  assert.deepEqual(new Set(cancelled), new Set(scheduled));
  assert.equal(
    (await api.handlers.get('before_tool_call')({ toolName: 'read', params: {} }, kimiContext('shutdown-a'))).block,
    true
  );
});

test('registration rejects missing, malformed, unknown, or unsafe recovery configuration', () => {
  const plugin = createManagedKimiPlugin({ gateway: async () => ({ ok: true }) });
  assert.throws(() => plugin.register(fakeApi(undefined)), /requires pluginConfig/);
  assert.throws(
    () => plugin.register(fakeApi({ ...CONFIG, modelProvider: 'kimi provider' })),
    /valid pluginConfig.modelProvider/
  );
  assert.throws(
    () => plugin.register(fakeApi({ ...CONFIG, recoveryEnabled: 'yes' })),
    /boolean pluginConfig.recoveryEnabled/
  );
  assert.throws(
    () => plugin.register(fakeApi({ ...CONFIG, extra: true })),
    /unknown pluginConfig key: extra/
  );
  const apiWithoutScheduler = fakeApi({ ...CONFIG, recoveryEnabled: true });
  delete apiWithoutScheduler.session;
  assert.throws(
    () => createManagedKimiPlugin({ gateway: async () => ({ ok: true }) }).register(apiWithoutScheduler),
    /scheduleSessionTurn/
  );
});
