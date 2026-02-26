import { OpenClawClient } from '@brad/clients';
import { advanceOnboarding, getOnboardingPrompt, requiresApproval } from '@brad/domain';
import type { ChannelType, InboundMessage, Person } from '@brad/domain';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { gatewayForChannel } from '../adapters/channel-gateway.js';
import { ApprovalService } from './approval-service.js';
import { AuditService } from './audit-service.js';
import { ConnectorService } from './connector-service.js';
import { LockService } from './lock-service.js';
import { MessageService } from './message-service.js';
import { ModelProfileService } from './model-profile-service.js';
import { PersonService } from './person-service.js';
import { RuntimeService } from './runtime-service.js';
import { ToolInvocationService } from './tool-invocation-service.js';
import { ToolRegistryService } from './tool-registry-service.js';
import { normalizePhoneE164Candidate } from '../utils/phone.js';

const personService = new PersonService();
const messageService = new MessageService();
const auditService = new AuditService();
const approvalService = new ApprovalService();
const connectorService = new ConnectorService();
const runtimeService = new RuntimeService();
const lockService = new LockService();
const modelProfileService = new ModelProfileService();
const toolRegistry = new ToolRegistryService();
const toolInvocationService = new ToolInvocationService();
const openclaw = new OpenClawClient(env.OPENCLAW_URL, env.OPENCLAW_API_KEY, {
  mode: env.OPENCLAW_MODE,
  cliBin: env.OPENCLAW_CLI_BIN,
  cliAgentId: env.OPENCLAW_CLI_AGENT_ID,
  cliTimeoutMs: env.OPENCLAW_CLI_TIMEOUT_MS
});

interface RouterReply {
  text: string;
  pendingApprovals?: Array<{ id: string; actionType: string }>;
  runId?: string;
  sessionId?: string;
}

export class TwinRouter {
  async handleInbound(inbound: InboundMessage): Promise<RouterReply> {
    const gateway = gatewayForChannel(inbound.channel);
    const identity = gateway.normalizeIdentity(inbound);

    const person = await personService.resolveOrCreateByChannel({
      channel: inbound.channel,
      externalUserKey: identity.externalUserKey,
      phoneE164: identity.phoneE164,
      verifiedPhone: Boolean(identity.phoneE164)
    });

    const inboundMessageId = await messageService.insert({
      personId: person.id,
      channel: inbound.channel,
      direction: 'INBOUND',
      body: inbound.text,
      providerMessageId: inbound.providerMessageId,
      metadata: inbound.metadata
    });

    await auditService.log({
      personId: person.id,
      eventType: 'MESSAGE_INBOUND',
      entityType: 'message',
      entityId: inboundMessageId,
      metadata: { channel: inbound.channel }
    });

    const verifiedPerson = await this.tryAutoVerifyPhone(inbound, identity.externalUserKey, person);

    const allowUnverifiedWeb = inbound.channel === 'WEB' && env.BETA_ALLOW_UNVERIFIED_WEB;
    if (!verifiedPerson.phoneVerified && !allowUnverifiedWeb) {
      const response =
        inbound.channel === 'TELEGRAM'
          ? 'Please share your phone in Telegram to continue onboarding. Tap attachment, then Contact, and send your own contact card.'
          : 'Please verify your phone in web login to continue onboarding.';
      await this.sendAndPersist(person.id, inbound.channel, identity.externalUserKey, response);
      return { text: response };
    }

    if (verifiedPerson.onboardingState !== 'ACTIVE') {
      return await this.handleOnboarding(
        verifiedPerson.id,
        verifiedPerson.onboardingState,
        inbound.text,
        inbound.channel,
        identity.externalUserKey
      );
    }

    return await this.handleRuntime(
      verifiedPerson.id,
      inbound.text,
      inbound.channel,
      identity.externalUserKey,
      inboundMessageId
    );
  }

  private async tryAutoVerifyPhone(
    inbound: InboundMessage,
    externalUserKey: string,
    person: Person
  ): Promise<Person> {
    const textPhoneCandidate =
      inbound.channel === 'TELEGRAM' ? normalizePhoneE164Candidate(inbound.text) : undefined;
    const verifiedPhoneCandidate = inbound.phoneE164 ?? textPhoneCandidate;

    if (person.phoneVerified || !verifiedPhoneCandidate) {
      return person;
    }

    await personService.markPhoneVerified(person.id, verifiedPhoneCandidate);
    await personService.upsertChannelIdentity({
      personId: person.id,
      channel: inbound.channel,
      externalUserKey,
      phoneE164: verifiedPhoneCandidate,
      verifiedPhone: true
    });

    await auditService.log({
      personId: person.id,
      eventType: 'PHONE_VERIFIED',
      entityType: 'person',
      entityId: person.id,
      metadata: {
        channel: inbound.channel,
        phoneE164: verifiedPhoneCandidate,
        source: inbound.phoneE164 ? 'contact' : 'message_text'
      }
    });

    return { ...person, phoneVerified: true, phoneE164: verifiedPhoneCandidate };
  }

  private async handleOnboarding(
    personId: string,
    state: 'ASK_NAME' | 'ASK_CONNECT_CALENDAR' | 'ASK_CONNECT_EMAIL' | 'CONFIRM_READY',
    text: string,
    channel: ChannelType,
    externalUserKey: string
  ): Promise<RouterReply> {
    const step = advanceOnboarding(state, text);

    if (state === 'ASK_NAME' && text.trim()) {
      await personService.updateName(personId, text.trim());
    }

    await personService.updateOnboardingState(personId, step.nextState);

    const response = step.nextState === state ? step.response : `${step.response}\n\n${getOnboardingPrompt(step.nextState)}`;
    await this.sendAndPersist(personId, channel, externalUserKey, response);
    return { text: response };
  }

  private async handleRuntime(
    personId: string,
    text: string,
    channel: ChannelType,
    externalUserKey: string,
    inboundMessageId: string
  ): Promise<RouterReply> {
    const hasLock = await lockService.acquire(personId);
    if (!hasLock) {
      const response = 'I am still finishing your previous request. Please try again in a few seconds.';
      await this.sendAndPersist(personId, channel, externalUserKey, response);
      return { text: response };
    }

    try {
      const policy = await personService.getPermissionPolicy(personId);
      const connectorRefs = await connectorService.listConnectorRefs(personId);
      const skills = await personService.listSkills(personId);
      const modelConfig = await modelProfileService.getOrCreate(personId);
      const runId = inboundMessageId;

      const runtime = await runtimeService.ensureRuntimeContext(personId, async () => {
        const boot = await openclaw.ensureRuntime({
          userId: personId,
          skills,
          permissions: policy,
          connectorRefs,
          runtimePolicy: {
            maxRetries: 2,
            idleTimeoutMinutes: 10
          },
          modelConfig
        });

        await auditService.log({
          personId,
          eventType: 'RUNTIME_PROVISIONED',
          entityType: 'runtime',
          entityId: boot.runtimeId,
          metadata: {
            model: modelConfig.model,
            temperature: modelConfig.temperature
          }
        });

        return { sessionId: boot.runtimeId };
      });

      await runtimeService.touchRuntime(personId);

      const pendingApprovals: Array<{ id: string; actionType: string }> = [];
      let assistantText = '';
      let sessionId = runtime.sessionId;
      let responseId = runtime.responseId;
      let writeBlockedByKillSwitch = false;

      let turn = await openclaw.executeTurn({
        runId,
        sessionId,
        userId: personId,
        inputText: text,
        previousResponseId: responseId,
        tools: toolRegistry.listToolDefinitions(),
        model: modelConfig.model,
        temperature: modelConfig.temperature,
        maxTokens: modelConfig.maxTokens,
        metadata: {
          connectorRefs,
          channel,
          person_id: personId
        }
      });

      assistantText = turn.assistantText;
      responseId = turn.responseId;
      await runtimeService.updateResponseId(personId, responseId);

      await auditService.log({
        personId,
        eventType: 'OPENCLAW_EXECUTION',
        entityType: 'message',
        entityId: inboundMessageId,
        metadata: {
          runId,
          sessionId,
          responseId,
          error: turn.error ?? null,
          toolCalls: turn.toolCalls.length
        }
      });

      for (let loop = 0; loop < 6; loop++) {
        if (!turn.toolCalls.length) {
          break;
        }

        const toolOutputs: Array<{ callId: string; output: Record<string, unknown> }> = [];

        for (const toolCall of turn.toolCalls) {
          let resolved;
          try {
            resolved = toolRegistry.resolveCall(toolCall);
          } catch (error) {
            toolOutputs.push({
              callId: toolCall.id,
              output: {
                ok: false,
                error: 'tool_schema_invalid',
                detail: error instanceof Error ? error.message : 'invalid_tool_call'
              }
            });
            continue;
          }

          const isWrite = resolved.isWrite;
          const actionType = resolved.actionType ?? (isWrite ? 'SUBMIT_FORM' : undefined);

          if (isWrite && env.BETA_KILL_SWITCH_WRITES) {
            writeBlockedByKillSwitch = true;
            await toolInvocationService.log({
              personId,
              messageId: inboundMessageId,
              toolName: resolved.name,
              toolCallId: resolved.callId,
              input: resolved.args,
              status: 'FAILED',
              errorCode: 'write_blocked_kill_switch'
            });
            toolOutputs.push({
              callId: resolved.callId,
              output: {
                ok: false,
                error: 'write_blocked_kill_switch',
                message: 'Write actions are temporarily disabled.'
              }
            });
            continue;
          }

          const approvalRequired =
            isWrite &&
            Boolean(actionType) &&
            (env.BETA_STRICT_APPROVALS || (actionType ? requiresApproval(policy, actionType) : false));

          if (approvalRequired && actionType) {
            const idempotencyKey = `${personId}:${runId}:${turn.responseId}:${resolved.callId}`;
            const { approvalId, approvalToken } = await approvalService.create({
              personId,
              actionType,
              payload: {
                runId,
                channel,
                externalUserKey,
                toolName: resolved.name,
                toolCallId: resolved.callId,
                toolInput: resolved.args,
                model: modelConfig.model
              },
              toolName: resolved.name,
              toolCallId: resolved.callId,
              toolInput: resolved.args,
              openclawSessionId: sessionId,
              openclawResponseId: turn.responseId,
              originChannel: channel,
              originExternalUserKey: externalUserKey,
              idempotencyKey
            });

            await toolInvocationService.log({
              personId,
              messageId: inboundMessageId,
              toolName: resolved.name,
              toolCallId: resolved.callId,
              input: resolved.args,
              status: 'PENDING_APPROVAL',
              approvalRequestId: approvalId
            });

            const approvalUrl = `${env.WEB_BASE_URL}/approvals/${approvalToken}`;
            const approvalText = `Approval required for ${actionType}. Confirm: ${approvalUrl}`;
            await this.sendAndPersist(personId, channel, externalUserKey, approvalText);

            await auditService.log({
              personId,
              eventType: 'APPROVAL_CREATED',
              entityType: 'approval_request',
              entityId: approvalId,
              metadata: { actionType, toolName: resolved.name, runId, sessionId }
            });

            pendingApprovals.push({ id: approvalId, actionType });
            continue;
          }

          const startedAt = Date.now();
          const execution = await this.executeToolWithRetries(personId, resolved.name, resolved.args, 2);
          const latencyMs = Date.now() - startedAt;

          if (execution.errorCode) {
            await toolInvocationService.log({
              personId,
              messageId: inboundMessageId,
              toolName: resolved.name,
              toolCallId: resolved.callId,
              input: resolved.args,
              output: execution.output,
              status: 'FAILED',
              retryCount: 1,
              latencyMs,
              errorCode: execution.errorCode
            });

            toolOutputs.push({
              callId: resolved.callId,
              output: {
                ok: false,
                error: execution.errorCode,
                manual_next_step: execution.manualNextStep ?? 'Complete this step manually and retry.'
              }
            });
            continue;
          }

          await toolInvocationService.log({
            personId,
            messageId: inboundMessageId,
            toolName: resolved.name,
            toolCallId: resolved.callId,
            input: resolved.args,
            output: execution.output,
            status: 'SUCCEEDED',
            latencyMs
          });

          toolOutputs.push({
            callId: resolved.callId,
            output: {
              ok: true,
              result: execution.output
            }
          });
        }

        if (pendingApprovals.length > 0) {
          break;
        }

        if (!toolOutputs.length) {
          break;
        }

        turn = await openclaw.executeTurn({
          runId,
          sessionId,
          userId: personId,
          previousResponseId: turn.responseId,
          toolOutputs,
          tools: toolRegistry.listToolDefinitions(),
          model: modelConfig.model,
          temperature: modelConfig.temperature,
          maxTokens: modelConfig.maxTokens,
          metadata: {
            connectorRefs,
            channel,
            person_id: personId
          }
        });

        assistantText = turn.assistantText || assistantText;
        responseId = turn.responseId;
        await runtimeService.updateResponseId(personId, responseId);
      }

      const assistant = writeBlockedByKillSwitch
        ? 'Write actions are temporarily disabled while we run beta safety checks. You can still ask read-only questions.'
        : turn.error
          ? 'I hit an issue while executing your request. Please try again or complete this manually.'
          : assistantText || 'I processed your request.';

      await this.sendAndPersist(personId, channel, externalUserKey, assistant);

      return {
        text: assistant,
        pendingApprovals,
        runId,
        sessionId
      };
    } finally {
      await lockService.release(personId);
    }
  }

  private async executeToolWithRetries(
    personId: string,
    toolName: string,
    args: Record<string, unknown>,
    maxRetries: number
  ): Promise<{ output: Record<string, unknown>; errorCode?: string; manualNextStep?: string }> {
    let lastError: { output: Record<string, unknown>; errorCode?: string; manualNextStep?: string } = {
      output: {},
      errorCode: 'tool_unknown_failure',
      manualNextStep: 'Complete this action manually and retry.'
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let result;
      try {
        result = await toolRegistry.execute(personId, {
          callId: randomUUID(),
          name: toolName,
          args,
          isWrite: false
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown_tool_exception';
        lastError = {
          output: { error: message },
          errorCode: 'tool_execution_exception',
          manualNextStep: 'Complete this action manually and retry.'
        };
        continue;
      }

      if (!result.errorCode) {
        return result;
      }

      lastError = result;
    }

    return lastError;
  }

  private async sendAndPersist(
    personId: string,
    channel: ChannelType,
    externalUserKey: string,
    text: string
  ): Promise<void> {
    const gateway = gatewayForChannel(channel);
    await gateway.sendOutbound({ channel, externalUserKey, text });

    const messageId = await messageService.insert({
      personId,
      channel,
      direction: 'OUTBOUND',
      body: text
    });

    await auditService.log({
      personId,
      eventType: 'MESSAGE_OUTBOUND',
      entityType: 'message',
      entityId: messageId,
      metadata: { channel }
    });
  }
}
