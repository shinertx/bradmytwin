import { OpenClawClient } from '@brad/clients';
import { advanceOnboarding, getOnboardingPrompt, requiresApproval } from '@brad/domain';
import type { ChannelType, InboundMessage, Person } from '@brad/domain';
import { env } from '../config/env.js';
import { gatewayForChannel } from '../adapters/channel-gateway.js';
import { AuditService } from './audit-service.js';
import { ApprovalService } from './approval-service.js';
import { ConnectorService } from './connector-service.js';
import { LockService } from './lock-service.js';
import { MessageService } from './message-service.js';
import { ModelProfileService } from './model-profile-service.js';
import { PersonService } from './person-service.js';
import { RuntimeService } from './runtime-service.js';
import { normalizePhoneE164Candidate } from '../utils/phone.js';

const personService = new PersonService();
const messageService = new MessageService();
const auditService = new AuditService();
const approvalService = new ApprovalService();
const connectorService = new ConnectorService();
const runtimeService = new RuntimeService();
const lockService = new LockService();
const modelProfileService = new ModelProfileService();
const openclaw = new OpenClawClient(env.OPENCLAW_URL, env.OPENCLAW_API_KEY, {
  mode: env.OPENCLAW_MODE,
  cliBin: env.OPENCLAW_CLI_BIN,
  cliAgentId: env.OPENCLAW_CLI_AGENT_ID,
  cliTimeoutMs: env.OPENCLAW_CLI_TIMEOUT_MS
});

export class TwinRouter {
  async handleInbound(inbound: InboundMessage): Promise<{ text: string }> {
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
  ): Promise<{ text: string }> {
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
  ): Promise<{ text: string }> {
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

      const runtimeId = await runtimeService.ensureRuntimeId(personId, async () => {
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

        return boot.runtimeId;
      });
      await runtimeService.touchRuntime(personId);

      const result = await openclaw.execute({
        runtimeId,
        userId: personId,
        messageId: inboundMessageId,
        inputText: text,
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
        eventType: 'OPENCLAW_EXECUTION',
        entityType: 'message',
        entityId: inboundMessageId,
        metadata: {
          error: result.error ?? null,
          toolRequests: result.toolRequests.length
        }
      });

      let writeBlockedByKillSwitch = false;
      for (const request of result.toolRequests) {
        if (request.isWrite && env.BETA_KILL_SWITCH_WRITES) {
          writeBlockedByKillSwitch = true;
          await auditService.log({
            personId,
            eventType: 'WRITE_BLOCKED_KILL_SWITCH',
            entityType: 'message',
            entityId: inboundMessageId,
            metadata: { toolName: request.toolName, actionType: request.actionType ?? null }
          });
          continue;
        }

        const actionType = request.actionType ?? (request.isWrite ? 'SUBMIT_FORM' : undefined);
        const approvalRequired = request.isWrite && Boolean(actionType) && (
          env.BETA_STRICT_APPROVALS || (actionType ? requiresApproval(policy, actionType) : false)
        );

        if (approvalRequired && actionType) {
          const { approvalId, approvalToken } = await approvalService.create({
            personId,
            actionType,
            payload: {
              ...request.payload,
              channel,
              externalUserKey,
              toolName: request.toolName
            }
          });

          const approvalUrl = `${env.WEB_BASE_URL}/approvals/${approvalToken}`;
          const approvalText = `Approval required for ${actionType}. Confirm: ${approvalUrl}`;
          await this.sendAndPersist(personId, channel, externalUserKey, approvalText);

          await auditService.log({
            personId,
            eventType: 'APPROVAL_CREATED',
            entityType: 'approval_request',
            entityId: approvalId,
            metadata: { actionType }
          });
        }
      }

      const assistant = writeBlockedByKillSwitch
        ? 'Write actions are temporarily disabled while we run beta safety checks. You can still ask read-only questions.'
        : result.error
          ? 'I hit an issue while executing your request. Please try again or complete this manually.'
          : result.assistantText;
      await this.sendAndPersist(personId, channel, externalUserKey, assistant);
      return { text: assistant };
    } finally {
      await lockService.release(personId);
    }
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
