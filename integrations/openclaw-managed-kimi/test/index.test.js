import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createManagedKimiPlugin } from '../index.js';

const CONFIG = {
  managedAgentId: 'brad-runtime',
  managedMainAccountDigest: createHash('sha256').update('internal-managed-account').digest('hex'),
  managedOwnerIdentity: 'kimi-claw:main',
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
  const warnings = [];
  return {
    pluginConfig: resolvedConfig,
    handlers,
    warnings,
    logger: { warn(message) { warnings.push(message); } },
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

function settledResponseDigest(text) {
  return createHash('sha256')
    .update(JSON.stringify({ artifactRefs: [], evidenceRefs: [], text }))
    .digest('hex');
}

async function claimNormal(api, runId, prompt = `objective ${runId}`, inboundOverrides = {}, ctxOverrides = {}) {
  const ctx = kimiContext(runId, { ...inboundOverrides, ...ctxOverrides });
  await api.handlers.get('inbound_claim')(inboundEvent(), ctx);
  const result = await api.handlers.get('before_agent_run')(runEvent(prompt), ctx);
  return { ctx, result };
}

async function claimFromMessageReceived(
  api,
  runId,
  prompt = `objective ${runId}`,
  eventOverrides = {},
  ctxOverrides = {}
) {
  const ctx = kimiContext(runId, { senderId: undefined, ...ctxOverrides });
  await api.handlers.get('message_received')({
    from: 'main',
    content: prompt,
    messageId: `provider-message-${runId}`,
    sessionKey: ctx.sessionKey,
    runId,
    ...eventOverrides
  }, ctx);
  const result = await api.handlers.get('before_agent_run')(
    runEvent(prompt, {
      accountId: 'main',
      senderId: undefined,
      senderIsOwner: undefined,
      ...eventOverrides
    }),
    ctx
  );
  return { ctx, result };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

function assertSafeOwnerShapeWarning(message) {
  assert.match(message, /^Brad managed owner context shape: event_keys=/);
  assert.match(message, /ctx_keys=/);
  assert.match(message, /channel_context_keys=/);
  assert.match(message, /sender_is_owner=(?:true|false)/);
  assert.doesNotMatch(message, /owner-1|conversation-1|objective|sensitive transport context/);
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

test('managed Kimi queued-message wrappers never contaminate the durable owner objective', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      return claim('normalized-wrapper');
    }
  }).register(api);
  const ownerPrompt = 'Audit the Brad control plane from first principles.';
  const wrappedPrompt = [
    '[Queued user message that arrived while the previous turn was still active]',
    'A stale transport error from the previous turn.',
    '',
    'User Message From Kimi:',
    '[Time: [2026-08-06 Thu 19:04:49 GMT+8]]',
    ownerPrompt
  ].join('\n');

  await claimFromMessageReceived(api, 'normalized-wrapper', wrappedPrompt);

  assert.equal(calls.find((call) => call.operation === 'intake')?.payload.text, ownerPrompt);
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

test('exact managed Kimi identity compensates for the connector owner-bit gap', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      return operation === 'intake' ? claim(payload.externalMessageId) : gatewayOk(operation);
    }
  }).register(api);

  const ctx = kimiContext('managed-owner-fallback', {
    messageProvider: 'kimi-claw',
    senderId: 'main'
  });
  await api.handlers.get('inbound_claim')(inboundEvent(), ctx);
  const result = await api.handlers.get('before_agent_run')(
    runEvent('managed owner fallback', { senderId: 'main', senderIsOwner: false }),
    ctx
  );

  assert.equal(result, undefined);
  assert.equal(calls[0].payload.senderId, 'main');
});

test('managed Kimi account identity joins the live hook shape when sender fields are absent', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      return operation === 'intake' ? claim(payload.externalMessageId) : gatewayOk(operation);
    }
  }).register(api);

  const ctx = kimiContext('managed-account-fallback', {
    messageProvider: 'kimi-claw',
    channelId: 'conversation-1',
    senderId: undefined
  });
  await api.handlers.get('inbound_claim')(inboundEvent(), ctx);
  const result = await api.handlers.get('before_agent_run')(
    runEvent('managed account fallback', {
      channelId: 'conversation-1',
      senderId: undefined,
      senderIsOwner: undefined,
      accountId: 'main'
    }),
    ctx
  );

  assert.equal(result, undefined);
  assert.equal(calls[0].operation, 'intake');
  assert.equal(calls[0].payload.senderId, 'main');
});

test('message_received provides durable provider correlation when Kimi omits inbound_claim', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      return operation === 'intake' ? claim(payload.externalMessageId) : gatewayOk(operation);
    }
  }).register(api);

  const { result } = await claimFromMessageReceived(api, 'message-received-fallback');

  assert.equal(result, undefined);
  assert.equal(calls[0].operation, 'intake');
  assert.equal(calls[0].payload.externalMessageId, 'provider-message-message-received-fallback');
  assert.equal(calls[0].payload.senderId, 'main');
  assert.equal(calls[0].payload.channel, 'KIMI');
});

test('managed Kimi uses the official stable run id when the channel emits no inbound hooks', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      return operation === 'intake' ? claim(payload.externalMessageId) : gatewayOk(operation);
    }
  }).register(api);
  const ctx = kimiContext('no-inbound-hooks', { senderId: undefined });
  const event = runEvent('managed run fallback', {
    accountId: 'main',
    senderId: undefined,
    senderIsOwner: undefined
  });

  assert.equal(await api.handlers.get('before_agent_run')(event, ctx), undefined);
  assert.equal(await api.handlers.get('before_agent_run')(event, ctx), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'intake');
  assert.equal(calls[0].payload.externalMessageId, 'openclaw-run:no-inbound-hooks');
  assert.equal(calls[0].payload.senderId, 'main');
  assert.equal(calls[0].payload.channel, 'KIMI');
});

test('managed Kimi accepts the official owner verdict when the connector redacts identity fields', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      return operation === 'intake' ? claim(payload.externalMessageId) : gatewayOk(operation);
    }
  }).register(api);
  const ctx = kimiContext('redacted-live-owner', {
    messageProvider: undefined,
    channel: undefined,
    channelId: undefined,
    senderId: undefined,
    accountId: undefined
  });
  const event = runEvent('managed redacted owner', {
    channelId: undefined,
    senderId: undefined,
    accountId: undefined,
    senderIsOwner: true
  });

  assert.equal(await api.handlers.get('before_agent_run')(event, ctx), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.externalMessageId, 'openclaw-run:redacted-live-owner');
  assert.equal(calls[0].payload.senderId, 'main');
  assert.equal(calls[0].payload.channel, 'KIMI');
});

test('managed Kimi main continuation joins the exact authenticated boot claim once', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      return operation === 'intake' ? claim(payload.externalMessageId) : gatewayOk(operation);
    },
    now: () => 1_000
  }).register(api);
  const prompt = 'one durable managed Kimi objective';
  const bootCtx = kimiContext('boot-run', {
    messageProvider: undefined,
    channel: undefined,
    channelId: undefined,
    chatId: undefined,
    senderId: undefined,
    accountId: undefined,
    sessionKey: `agent:${CONFIG.managedAgentId}:boot`
  });
  const bootEvent = runEvent(prompt, {
    channelId: undefined,
    senderId: undefined,
    accountId: undefined,
    senderIsOwner: true
  });
  assert.equal(await api.handlers.get('before_agent_run')(bootEvent, bootCtx), undefined);

  const mainCtx = kimiContext('main-run', {
    messageProvider: undefined,
    channel: undefined,
    channelId: undefined,
    chatId: undefined,
    senderId: undefined,
    accountId: undefined,
    sessionKey: `agent:${CONFIG.managedAgentId}:main`
  });
  const mainEvent = runEvent(prompt, {
    channelId: undefined,
    senderId: undefined,
    accountId: 'internal-managed-account',
    senderIsOwner: false
  });
  assert.equal(await api.handlers.get('before_agent_run')(mainEvent, mainCtx), undefined);
  assert.equal(calls.filter((call) => call.operation === 'intake').length, 1);

  await api.handlers.get('agent_end')({ success: false }, bootCtx);
  await api.handlers.get('before_agent_finalize')(
    { lastAssistantMessage: { role: 'assistant', content: 'joined response' } },
    bootCtx
  );
  assert.equal(calls.filter((call) => call.operation === 'thread-reply').length, 0);
  await api.handlers.get('before_agent_finalize')(
    { lastAssistantMessage: { role: 'assistant', content: 'joined response' } },
    mainCtx
  );
  assert.equal(calls.filter((call) => call.operation === 'thread-reply').length, 1);

  await api.handlers.get('message_sent')(
    { runId: 'main-run', success: true, messageId: 'managed-kimi-response' },
    mainCtx
  );
  await api.handlers.get('message_sent')(
    { runId: 'boot-run', success: true, messageId: 'outer-wrapper-response' },
    bootCtx
  );
  assert.equal(calls.filter((call) => call.operation === 'thread-delivery').length, 1);
  assert.equal(
    await api.handlers.get('reply_payload_sending')({ kind: 'final', runId: 'boot-run' }, bootCtx),
    undefined
  );
  assert.equal(
    await api.handlers.get('reply_payload_sending')(
      { kind: 'final', sessionKey: bootCtx.sessionKey },
      { sessionKey: bootCtx.sessionKey }
    ),
    undefined
  );
});

test('managed Kimi continuation resumes a boot claim across isolated plugin contexts', async () => {
  const calls = [];
  const prompt = 'cross-context managed Kimi objective';
  const bootApi = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ runtime: 'boot', operation, payload });
      return operation === 'intake' ? claim('cross-context') : gatewayOk(operation);
    },
    now: () => 2_000
  }).register(bootApi);
  const bootCtx = kimiContext('cross-context-boot', {
    messageProvider: undefined,
    channel: undefined,
    channelId: undefined,
    chatId: undefined,
    senderId: undefined,
    sessionKey: `agent:${CONFIG.managedAgentId}:boot`
  });
  assert.equal(await bootApi.handlers.get('before_agent_run')(
    runEvent(prompt, {
      channelId: undefined,
      senderId: undefined,
      accountId: undefined,
      senderIsOwner: true
    }),
    bootCtx
  ), undefined);

  const mainApi = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ runtime: 'main', operation, payload });
      if (operation === 'continuation') {
        return {
          ok: true,
          assignment: {
            inbound_id: 'inbound-cross-context',
            claimToken: 'claim-cross-context',
            job_id: 'job-cross-context',
            thread_id: 'thread-cross-context',
            objective_id: 'objective-cross-context',
            session_key: `agent:${CONFIG.managedAgentId}:main`,
            channel: 'KIMI',
            conversation_id: `agent:${CONFIG.managedAgentId}:boot`,
            goal: prompt,
            definition_of_done: 'verified result',
            verification_method: 'source of truth',
            messages: []
          }
        };
      }
      return gatewayOk(operation);
    },
    now: () => 2_001
  }).register(mainApi);
  const mainCtx = kimiContext('cross-context-main', {
    messageProvider: undefined,
    channel: undefined,
    channelId: undefined,
    chatId: undefined,
    senderId: undefined,
    sessionKey: `agent:${CONFIG.managedAgentId}:main`
  });
  assert.equal(await mainApi.handlers.get('before_agent_run')(
    runEvent(prompt, {
      channelId: undefined,
      senderId: undefined,
      accountId: 'internal-managed-account',
      senderIsOwner: false
    }),
    mainCtx
  ), undefined);
  assert.equal(calls.filter((call) => call.runtime === 'main' && call.operation === 'intake').length, 0);
  assert.equal(calls.filter((call) => call.operation === 'continuation').length, 1);

  await mainApi.handlers.get('before_agent_finalize')(
    { lastAssistantMessage: { role: 'assistant', content: 'cross-context response' } },
    mainCtx
  );
  const reply = calls.find((call) => call.runtime === 'main' && call.operation === 'thread-reply');
  assert.deepEqual(reply.payload, {
    claimToken: 'claim-cross-context',
    jobId: 'job-cross-context',
    threadId: 'thread-cross-context',
    objectiveId: 'objective-cross-context',
    claimOwner: 'openclaw-run:cross-context-main',
    sessionId: 'session-cross-context-main',
    text: 'cross-context response'
  });
});

test('persistent managed Kimi main session authenticates by its configured account fingerprint', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      if (operation === 'continuation') return { ok: true, assignment: null };
      return operation === 'intake' ? claim(payload.externalMessageId) : gatewayOk(operation);
    }
  }).register(api);
  const ctx = kimiContext('persistent-main', {
    messageProvider: undefined,
    channel: undefined,
    channelId: undefined,
    chatId: undefined,
    senderId: undefined,
    sessionKey: `agent:${CONFIG.managedAgentId}:main`
  });
  const result = await api.handlers.get('before_agent_run')(
    runEvent('persistent managed objective', {
      channelId: undefined,
      senderId: undefined,
      accountId: 'internal-managed-account',
      senderIsOwner: false
    }),
    ctx
  );

  assert.equal(result, undefined);
  assert.deepEqual(calls.map((call) => call.operation), ['continuation', 'intake']);
  assert.equal(calls[1].payload.senderId, 'main');
  assert.equal(calls[1].payload.channel, 'KIMI');
  assert.equal(calls[1].payload.sessionKey, `agent:${CONFIG.managedAgentId}:main`);
});

test('persistent managed Kimi main session rejects a foreign account fingerprint', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      return { ok: true, assignment: null };
    }
  }).register(api);
  const result = await api.handlers.get('before_agent_run')(
    runEvent('must not run', {
      channelId: undefined,
      senderId: undefined,
      accountId: 'foreign-managed-account',
      senderIsOwner: false
    }),
    kimiContext('foreign-persistent-main', {
      messageProvider: undefined,
      channel: undefined,
      channelId: undefined,
      chatId: undefined,
      senderId: undefined,
      sessionKey: `agent:${CONFIG.managedAgentId}:main`
    })
  );

  assert.equal(result.outcome, 'block');
  assert.deepEqual(calls.map((call) => call.operation), ['continuation']);
});

test('managed Kimi continuation rejects prompt, missing-account, and time-window mismatches', async () => {
  let currentTime = 1_000;
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      return operation === 'intake' ? claim(payload.externalMessageId) : gatewayOk(operation);
    },
    now: () => currentTime
  }).register(api);
  const bootCtx = kimiContext('strict-boot', {
    messageProvider: undefined,
    channel: undefined,
    channelId: undefined,
    chatId: undefined,
    senderId: undefined,
    sessionKey: `agent:${CONFIG.managedAgentId}:boot`
  });
  await api.handlers.get('before_agent_run')(
    runEvent('exact objective', {
      channelId: undefined,
      senderId: undefined,
      accountId: undefined,
      senderIsOwner: true
    }),
    bootCtx
  );

  const continuation = (runId, prompt, accountId) => api.handlers.get('before_agent_run')(
    runEvent(prompt, {
      channelId: undefined,
      senderId: undefined,
      accountId,
      senderIsOwner: false
    }),
    kimiContext(runId, {
      messageProvider: undefined,
      channel: undefined,
      channelId: undefined,
      chatId: undefined,
      senderId: undefined,
      sessionKey: `agent:${CONFIG.managedAgentId}:main`
    })
  );
  assert.equal((await continuation('wrong-prompt', 'different objective', 'main')).outcome, 'block');
  assert.equal((await continuation('missing-account', 'exact objective', undefined)).outcome, 'block');
  currentTime = 31_001;
  assert.equal((await continuation('stale', 'exact objective', 'main')).outcome, 'block');
  assert.equal(calls.filter((call) => call.operation === 'intake').length, 1);
});

test('redacted identity fields without the official owner verdict fail closed', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({ gateway: async (...args) => { calls.push(args); return claim('unsafe'); } }).register(api);
  const ctx = kimiContext('redacted-non-owner', {
    messageProvider: undefined,
    channel: undefined,
    channelId: undefined,
    senderId: undefined,
    accountId: undefined
  });
  const result = await api.handlers.get('before_agent_run')(
    runEvent('must not run', {
      channelId: undefined,
      senderId: undefined,
      accountId: undefined,
      senderIsOwner: false
    }),
    ctx
  );

  assert.equal(result.outcome, 'block');
  assert.deepEqual(calls, []);
  assert.equal(api.warnings[0], 'Brad managed intake blocked: managed_kimi_inbound_hooks_not_emitted');
  assertSafeOwnerShapeWarning(api.warnings[1]);
});

test('run-id fallback is unavailable outside the exact managed Kimi channel', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({ gateway: async (...args) => { calls.push(args); return claim('unsafe'); } }).register(api);
  const ctx = kimiContext('web-without-inbound', {
    messageProvider: 'web',
    channel: 'web',
    channelId: 'web-conversation',
    senderId: 'owner-1'
  });
  const result = await api.handlers.get('before_agent_run')(
    runEvent('must not run', {
      channelId: 'web',
      accountId: 'main',
      senderIsOwner: true
    }),
    ctx
  );

  assert.equal(result.outcome, 'block');
  assert.deepEqual(calls, []);
  assert.equal(api.warnings[0], 'Brad managed intake blocked: managed_kimi_inbound_hooks_not_emitted');
  assertSafeOwnerShapeWarning(api.warnings[1]);
});

test('conflicting inbound hook correlations fail closed before intake', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({ gateway: async (...args) => { calls.push(args); return claim('unsafe'); } }).register(api);
  const ctx = kimiContext('correlation-conflict');
  await api.handlers.get('message_received')({
    from: 'main',
    content: 'objective',
    messageId: 'provider-message-a',
    sessionKey: ctx.sessionKey,
    runId: 'correlation-conflict'
  }, ctx);
  await api.handlers.get('inbound_claim')(
    inboundEvent({ messageId: 'provider-message-b' }),
    ctx
  );
  const result = await api.handlers.get('before_agent_run')(runEvent('must not run'), ctx);

  assert.equal(result.outcome, 'block');
  assert.deepEqual(calls, []);
  assert.equal(api.warnings[0], 'Brad managed intake blocked: managed_kimi_inbound_correlation_conflict');
  assertSafeOwnerShapeWarning(api.warnings[1]);
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
    const ctx = kimiContext(runId, { senderId: 'not-the-managed-owner' });
    await api.handlers.get('inbound_claim')(inboundEvent(), ctx);
    const event = runEvent('must not run');
    if (senderIsOwner === undefined) delete event.senderIsOwner;
    else event.senderIsOwner = senderIsOwner;
    const result = await api.handlers.get('before_agent_run')(event, ctx);
    assert.equal(result.outcome, 'block');
  }
  assert.deepEqual(calls, []);
  assert.equal(api.warnings[0], 'Brad managed intake blocked: managed_kimi_owner_identity_mismatch');
  assertSafeOwnerShapeWarning(api.warnings[1]);
  assert.equal(api.warnings[2], 'Brad managed intake blocked: managed_kimi_owner_identity_mismatch');
});

test('managed Kimi account identity must match exactly and cannot authorize another account', async () => {
  const calls = [];
  const api = fakeApi();
  createManagedKimiPlugin({ gateway: async (...args) => { calls.push(args); return claim('unsafe'); } }).register(api);
  const ctx = kimiContext('wrong-account', { senderId: undefined, accountId: 'other' });
  await api.handlers.get('inbound_claim')(inboundEvent(), ctx);
  const result = await api.handlers.get('before_agent_run')(
    runEvent('must not run', {
      senderId: undefined,
      senderIsOwner: false,
      accountId: 'other'
    }),
    ctx
  );

  assert.equal(result.outcome, 'block');
  assert.deepEqual(calls, []);
  assert.equal(api.warnings[0], 'Brad managed intake blocked: managed_kimi_owner_identity_mismatch');
  assertSafeOwnerShapeWarning(api.warnings[1]);
});

test('unexpected intake failures log a redacted stable code and value-free metadata shape', async () => {
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async () => {
      throw new Error('network failure containing sensitive transport context');
    }
  }).register(api);

  const { result } = await claimNormal(api, 'redacted-failure');
  assert.equal(result.outcome, 'block');
  assert.equal(api.warnings[0], 'Brad managed intake blocked: managed_kimi_claim_failed');
  assertSafeOwnerShapeWarning(api.warnings[1]);
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

test('outbound delivery matches the exact response when a persistent session has multiple settled runs', async () => {
  const calls = [];
  const gateway = async (operation, payload) => {
    calls.push({ operation, payload });
    if (operation === 'intake') return claim(payload.externalMessageId);
    if (operation === 'thread-reply') {
      return { ok: true, responseDigest: settledResponseDigest(payload.text) };
    }
    return gatewayOk(operation);
  };
  const api = fakeApi();
  createManagedKimiPlugin({ gateway }).register(api);
  const sharedSession = 'agent:brad-runtime:main';

  const first = await claimNormal(api, 'persistent-first', 'first objective', {}, { sessionKey: sharedSession });
  const second = await claimNormal(api, 'persistent-second', 'second objective', {}, { sessionKey: sharedSession });
  await api.handlers.get('before_agent_finalize')(
    { lastAssistantMessage: 'first exact response' },
    first.ctx
  );
  await api.handlers.get('before_agent_finalize')(
    { lastAssistantMessage: 'second exact response' },
    second.ctx
  );

  await api.handlers.get('message_sent')(
    {
      content: 'second exact response',
      success: true,
      messageId: 'provider-second-response',
      sessionKey: sharedSession
    },
    { sessionKey: sharedSession }
  );

  const delivery = calls.filter((call) => call.operation === 'thread-delivery');
  assert.equal(delivery.length, 1);
  assert.equal(delivery[0].payload.inboundId, 'inbound-persistent-second');
  assert.equal(delivery[0].payload.jobId, 'job-persistent-second');
  assert.equal(delivery[0].payload.messageId, 'provider-second-response');
});

test('missing connector receipts become reconcile-required instead of remaining pending or retrying', async () => {
  const calls = [];
  let receiptTimeout = null;
  const api = fakeApi();
  createManagedKimiPlugin({
    gateway: async (operation, payload) => {
      calls.push({ operation, payload });
      if (operation === 'intake') return claim(payload.externalMessageId);
      if (operation === 'thread-reply') {
        return { ok: true, responseDigest: settledResponseDigest(payload.text) };
      }
      return gatewayOk(operation);
    },
    setTimeout(callback, delay) {
      assert.equal(delay, 30_000);
      receiptTimeout = { callback, unref() {} };
      return receiptTimeout;
    },
    clearTimeout(timer) {
      if (timer === receiptTimeout) receiptTimeout = null;
    }
  }).register(api);

  const { ctx } = await claimNormal(api, 'missing-receipt');
  await api.handlers.get('before_agent_finalize')(
    { lastAssistantMessage: 'provider-visible but not acknowledged' },
    ctx
  );
  assert.ok(receiptTimeout);

  receiptTimeout.callback();
  await flushPromises();
  await flushPromises();

  const delivery = calls.filter((call) => call.operation === 'thread-delivery');
  assert.equal(delivery.length, 1);
  assert.equal(delivery[0].payload.success, false);
  assert.equal(delivery[0].payload.messageId, null);
  assert.equal(
    (await api.handlers.get('reply_payload_sending')({ kind: 'final', runId: 'missing-receipt' }, ctx)).cancel,
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
    () => plugin.register(fakeApi({ ...CONFIG, managedOwnerIdentity: 'kimi claw main' })),
    /valid pluginConfig.managedOwnerIdentity/
  );
  assert.throws(
    () => plugin.register(fakeApi({ ...CONFIG, managedMainAccountDigest: 'not-a-digest' })),
    /valid pluginConfig.managedMainAccountDigest/
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
