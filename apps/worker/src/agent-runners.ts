import { OpenClawClient } from '@brad/clients';
import { AGENT_IDS, type AgentId, type AuthorityEnvelope } from '@brad/domain';
import { readFile } from 'node:fs/promises';
import { ProcessHermesRunner } from './hermes-runner.js';
import { sha256 } from './digest.js';

export interface AgentRunRequest {
  jobId: string;
  objectiveId: string;
  threadId: string;
  triggerMessageId: string;
  agentId: AgentId;
  personId: string;
  prompt: string;
  context: Array<{ sender: string; type: string; body: string }>;
  authority: AuthorityEnvelope;
  sessionId?: string;
  verificationContract?: Record<string, unknown>;
}

export interface AgentRunResult {
  text: string;
  sessionId?: string;
  model?: string;
  provider?: string;
  artifactRefs: Array<Record<string, unknown>>;
  evidenceRefs: Array<Record<string, unknown>>;
  usage?: Record<string, unknown>;
  costMicros?: number;
  blockerCode?: string;
  verified?: boolean;
  deferred?: boolean;
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export type AgentRunnerRegistry = Map<string, AgentRunner>;

function stripFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function parseStructuredResult(text: string): Partial<AgentRunResult> {
  try {
    const parsed = JSON.parse(stripFence(text)) as Record<string, unknown>;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : text,
      artifactRefs: Array.isArray(parsed.artifactRefs) ? parsed.artifactRefs as Array<Record<string, unknown>> : [],
      evidenceRefs: Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs as Array<Record<string, unknown>> : [],
      blockerCode: typeof parsed.blockerCode === 'string' ? parsed.blockerCode : undefined
    };
  } catch {
    return { text, artifactRefs: [], evidenceRefs: [] };
  }
}

export class OpenClawAgentRunner implements AgentRunner {
  private readonly client: OpenClawClient;

  constructor(private readonly config: {
    baseUrl?: string;
    apiKey?: string;
    mode: 'stub' | 'http' | 'cli';
    cliBin: string;
    cliAgentId?: string;
    timeoutMs: number;
    model: string;
  }) {
    this.client = new OpenClawClient(config.baseUrl, config.apiKey, {
      mode: config.mode,
      cliBin: config.cliBin,
      cliAgentId: config.cliAgentId,
      cliTimeoutMs: config.timeoutMs
    });
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const context = request.context.map((message) => `[${message.sender}/${message.type}] ${message.body}`).join('\n\n');
    const prompt = [
      'You are Brad, the Kimi-powered executive. Think from first principles and own the objective, but do not claim completion.',
      'Return JSON only with keys: text, artifactRefs, evidenceRefs, blockerCode.',
      `Authority envelope: ${JSON.stringify(request.authority)}`,
      `Objective: ${request.prompt}`,
      `Conversation:\n${context}`,
      'Delegate a concrete next assignment to Hermes. Consequential external effects remain approval-gated.'
    ].join('\n\n');
    const sessionId = request.sessionId ?? `agent:${request.agentId}:${request.threadId}`;
    const result = await this.client.executeTurn({
      runId: request.jobId,
      sessionId,
      userId: request.personId,
      inputText: prompt,
      tools: [],
      model: this.config.model,
      temperature: 0.2,
      maxTokens: 2200,
      metadata: { objective_id: request.objectiveId, thread_id: request.threadId, role: request.agentId }
    });
    if (result.error) {
      return { text: result.assistantText, sessionId, artifactRefs: [], evidenceRefs: [], blockerCode: result.error };
    }
    return {
      ...parseStructuredResult(result.assistantText),
      text: parseStructuredResult(result.assistantText).text ?? result.assistantText,
      sessionId,
      model: this.config.model,
      provider: 'openclaw'
    } as AgentRunResult;
  }
}

export class HermesAgentRunner implements AgentRunner {
  constructor(private readonly runner: ProcessHermesRunner, private readonly artifactRoot: string) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const result = await this.runner.run({
      jobId: request.jobId,
      prompt: request.prompt,
      skills: [],
      toolsets: request.authority.level === 'READ_ONLY' ? ['clarify'] : ['clarify'],
      objectiveId: request.objectiveId,
      threadId: request.threadId,
      messageId: request.triggerMessageId,
      sessionId: request.sessionId,
      authorityEnvelope: request.authority,
      artifactRoot: this.artifactRoot,
      mode: 'RESEARCH'
    });
    return {
      text: result.result,
      sessionId: result.sessionId,
      model: result.model,
      provider: result.provider,
      artifactRefs: [{ uri: result.artifactUri, sha256: result.artifactSha256 }],
      evidenceRefs: [],
      usage: result.usage
    };
  }
}

export class DeferredBuzzAgentRunner implements AgentRunner {
  constructor(private readonly agentId: 'codex' | 'claude') {}

  async run(): Promise<AgentRunResult> {
    return {
      text: `${this.agentId} assignment published to Buzz; waiting for a signed agent reply.`,
      artifactRefs: [],
      evidenceRefs: [],
      deferred: true,
      blockerCode: 'WAITING_BUZZ_AGENT_REPLY'
    };
  }
}

export class DeterministicVerifierRunner implements AgentRunner {
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const contract = request.verificationContract ?? {};
    const kind = typeof contract.kind === 'string' ? contract.kind : '';
    const expected = typeof contract.expected === 'string' ? contract.expected : '';
    const combined = request.context.map((message) => message.body).join('\n');

    if (kind === 'EXACT_MARKER' && expected && combined.includes(expected)) {
      return {
        text: `Verified exact marker: ${expected}`,
        artifactRefs: [],
        evidenceRefs: [{ kind, expected }],
        verified: true
      };
    }

    if (kind === 'ARTIFACT_SHA256') {
      const artifact = request.context
        .flatMap((message) => {
          try {
            const parsed = JSON.parse(message.body) as { artifactRefs?: Array<Record<string, unknown>> };
            return parsed.artifactRefs ?? [];
          } catch {
            return [];
          }
        })
        .find((candidate) => typeof candidate.uri === 'string' && typeof candidate.sha256 === 'string');
      if (artifact && typeof artifact.uri === 'string') {
        const content = await readFile(artifact.uri);
        if (sha256(content) === artifact.sha256) {
          return { text: `Verified artifact digest: ${artifact.uri}`, artifactRefs: [], evidenceRefs: [artifact], verified: true };
        }
      }
    }

    return {
      text: 'Independent completion evidence is missing or does not satisfy the verification contract.',
      artifactRefs: [],
      evidenceRefs: [],
      verified: false,
      blockerCode: 'INDEPENDENT_VERIFICATION_REQUIRED'
    };
  }
}

export function builtInRunnerRegistry(input: {
  openclaw: ConstructorParameters<typeof OpenClawAgentRunner>[0];
  hermes?: { runner: ProcessHermesRunner; artifactRoot: string };
}): AgentRunnerRegistry {
  const registry: AgentRunnerRegistry = new Map();
  registry.set(AGENT_IDS.BRAD_KIMI, new OpenClawAgentRunner(input.openclaw));
  if (input.hermes) registry.set(AGENT_IDS.HERMES, new HermesAgentRunner(input.hermes.runner, input.hermes.artifactRoot));
  registry.set(AGENT_IDS.CODEX, new DeferredBuzzAgentRunner('codex'));
  registry.set(AGENT_IDS.CLAUDE, new DeferredBuzzAgentRunner('claude'));
  registry.set(AGENT_IDS.VERIFIER, new DeterministicVerifierRunner());
  return registry;
}
