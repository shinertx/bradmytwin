import type {
  OpenClawResponse,
  OpenClawToolCall,
  OpenClawToolOutput,
  OpenClawTurnInput,
  OpenClawTurnResult,
  ToolDefinition
} from '@brad/domain';
import type { ToolRequest } from '@brad/domain';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ModelConfig {
  model: string;
  temperature: number;
  maxTokens: number;
}

export type OpenClawMode = 'stub' | 'http' | 'cli';

export interface OpenClawRuntimeBootInput {
  userId: string;
  skills: string[];
  permissions: {
    readAllowed: boolean;
    writeRequiresApproval: boolean;
  };
  connectorRefs: string[];
  runtimePolicy: {
    maxRetries: number;
    idleTimeoutMinutes: number;
  };
  modelConfig: ModelConfig;
}

export interface OpenClawExecuteInput {
  runtimeId: string;
  userId: string;
  messageId: string;
  inputText: string;
  skills: string[];
  permissions: {
    readAllowed: boolean;
    writeRequiresApproval: boolean;
  };
  connectorRefs: string[];
  runtimePolicy: {
    maxRetries: number;
    idleTimeoutMinutes: number;
  };
  modelConfig: ModelConfig;
}

export interface OpenClawClientOptions {
  mode?: OpenClawMode;
  cliBin?: string;
  cliAgentId?: string;
  cliTimeoutMs?: number;
  responsesPath?: string;
}

interface ResponsesApiResponse {
  id?: string;
  response_id?: string;
  run_id?: string;
  output_text?: string;
  output?: Array<Record<string, unknown>>;
}

export class OpenClawClient {
  private readonly mode: OpenClawMode;
  private readonly cliBin: string;
  private readonly cliAgentId?: string;
  private readonly cliTimeoutMs: number;
  private readonly responsesPath: string;

  constructor(
    private readonly baseUrl: string | undefined,
    private readonly apiKey: string | undefined,
    options: OpenClawClientOptions = {}
  ) {
    this.mode = options.mode ?? (baseUrl ? 'http' : 'stub');
    this.cliBin = options.cliBin ?? 'openclaw';
    this.cliAgentId = options.cliAgentId;
    this.cliTimeoutMs = options.cliTimeoutMs ?? 90_000;
    this.responsesPath = options.responsesPath ?? '/v1/responses';
  }

  async ensureRuntime(input: OpenClawRuntimeBootInput): Promise<{ runtimeId: string }> {
    if (this.mode === 'stub') {
      return { runtimeId: `local-runtime-${input.userId}` };
    }

    if (this.mode === 'cli') {
      return { runtimeId: `oc-session-${input.userId}` };
    }

    return { runtimeId: `oc-http-session-${input.userId}` };
  }

  async executeTurn(input: OpenClawTurnInput): Promise<OpenClawTurnResult> {
    if (this.mode === 'stub') {
      return {
        runId: input.runId,
        sessionId: input.sessionId,
        responseId: randomUUID(),
        assistantText: input.inputText ? `Stub: ${input.inputText}` : 'Stub tool output processed.',
        toolCalls: []
      };
    }

    if (this.mode === 'cli') {
      return await this.executeTurnViaCli(input);
    }

    return await this.executeTurnViaHttp(input);
  }

  async execute(input: OpenClawExecuteInput): Promise<OpenClawResponse> {
    const turn = await this.executeTurn({
      runId: input.messageId,
      sessionId: input.runtimeId,
      userId: input.userId,
      inputText: input.inputText,
      tools: [],
      model: input.modelConfig.model,
      temperature: input.modelConfig.temperature,
      maxTokens: input.modelConfig.maxTokens,
      metadata: {
        connectorRefs: input.connectorRefs,
        skills: input.skills,
        permissions: input.permissions
      }
    });

    const legacyToolRequests: ToolRequest[] = turn.toolCalls.map((call) => ({
      id: call.id,
      toolName: call.name,
      isWrite: false,
      payload: call.arguments
    }));

    return {
      assistantText: turn.assistantText,
      toolRequests: legacyToolRequests,
      error: turn.error
    };
  }

  private async executeTurnViaHttp(input: OpenClawTurnInput): Promise<OpenClawTurnResult> {
    if (!this.baseUrl) {
      return {
        runId: input.runId,
        sessionId: input.sessionId,
        responseId: randomUUID(),
        assistantText: 'OpenClaw HTTP base URL is not configured.',
        toolCalls: [],
        error: 'openclaw_http_missing_base_url'
      };
    }

    const payload: Record<string, unknown> = {
      model: input.model,
      temperature: input.temperature,
      max_output_tokens: input.maxTokens,
      user: input.userId,
      metadata: {
        ...(input.metadata ?? {}),
        run_id: input.runId,
        session_id: input.sessionId
      },
      tools: input.tools.map((tool) => this.toResponsesTool(tool))
    };

    if (input.previousResponseId) {
      payload.previous_response_id = input.previousResponseId;
    }

    if (input.toolOutputs && input.toolOutputs.length > 0) {
      payload.input = input.toolOutputs.map((out) => this.toFunctionCallOutput(out));
    } else {
      payload.input = input.inputText ?? '';
    }

    try {
      const res = await fetch(`${this.baseUrl}${this.responsesPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          'x-openclaw-session-key': input.sessionId
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const body = await res.text();
        return {
          runId: input.runId,
          sessionId: input.sessionId,
          responseId: randomUUID(),
          assistantText: 'I could not reach the OpenClaw responses API.',
          toolCalls: [],
          error: `openclaw_http_${res.status}:${body.slice(0, 200)}`
        };
      }

      const body = (await res.json()) as ResponsesApiResponse;
      return {
        runId: body.run_id ?? input.runId,
        sessionId: input.sessionId,
        responseId: body.id ?? body.response_id ?? randomUUID(),
        assistantText: this.extractAssistantText(body),
        toolCalls: this.extractToolCalls(body),
        error: undefined
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      return {
        runId: input.runId,
        sessionId: input.sessionId,
        responseId: randomUUID(),
        assistantText: 'I could not reach the OpenClaw responses API.',
        toolCalls: [],
        error: `openclaw_http_network:${message}`
      };
    }
  }

  private async executeTurnViaCli(input: OpenClawTurnInput): Promise<OpenClawTurnResult> {
    try {
      const args = ['agent', '--session-id', input.sessionId, '--message', input.inputText ?? '', '--json'];
      if (this.cliAgentId) {
        args.splice(1, 0, '--agent', this.cliAgentId);
      }

      const { stdout } = await execFileAsync(this.cliBin, args, {
        timeout: this.cliTimeoutMs,
        maxBuffer: 8 * 1024 * 1024
      });

      const parsed = this.extractJson(stdout);
      const assistantText = this.extractAssistantText(parsed);

      return {
        runId: input.runId,
        sessionId: input.sessionId,
        responseId: randomUUID(),
        assistantText: assistantText || 'I processed your request.',
        toolCalls: []
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_cli_error';
      return {
        runId: input.runId,
        sessionId: input.sessionId,
        responseId: randomUUID(),
        assistantText: 'I could not execute on the OpenClaw gateway right now.',
        toolCalls: [],
        error: `openclaw_cli_error:${message}`
      };
    }
  }

  private toResponsesTool(tool: ToolDefinition): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    };
  }

  private toFunctionCallOutput(out: OpenClawToolOutput): Record<string, unknown> {
    return {
      type: 'function_call_output',
      call_id: out.callId,
      output: JSON.stringify(out.output)
    };
  }

  private extractAssistantText(body: unknown): string {
    if (!body || typeof body !== 'object') {
      return '';
    }

    const typed = body as ResponsesApiResponse;
    if (typeof typed.output_text === 'string' && typed.output_text.trim()) {
      return typed.output_text.trim();
    }

    const output = Array.isArray(typed.output) ? typed.output : [];
    const chunks: string[] = [];

    for (const item of output) {
      if (typeof item.type === 'string' && item.type === 'message') {
        const content = Array.isArray(item.content) ? item.content : [];
        for (const entry of content) {
          const text = this.extractTextFromContentEntry(entry);
          if (text) {
            chunks.push(text);
          }
        }
      }

      if (typeof item.type === 'string' && (item.type === 'output_text' || item.type === 'text')) {
        const text = this.extractTextFromContentEntry(item);
        if (text) {
          chunks.push(text);
        }
      }
    }

    return chunks.join('\n').trim();
  }

  private extractTextFromContentEntry(entry: unknown): string {
    if (!entry || typeof entry !== 'object') {
      return '';
    }

    const typed = entry as Record<string, unknown>;
    if (typeof typed.text === 'string') {
      return typed.text;
    }

    const nestedText = typed.text as Record<string, unknown> | undefined;
    if (nestedText && typeof nestedText.value === 'string') {
      return nestedText.value;
    }

    return '';
  }

  private extractToolCalls(body: ResponsesApiResponse): OpenClawToolCall[] {
    const output = Array.isArray(body.output) ? body.output : [];
    const calls: OpenClawToolCall[] = [];

    for (const item of output) {
      const itemCalls = this.extractToolCallsFromOutputItem(item);
      calls.push(...itemCalls);
    }

    return calls;
  }

  private extractToolCallsFromOutputItem(item: Record<string, unknown>): OpenClawToolCall[] {
    const calls: OpenClawToolCall[] = [];

    const directType = typeof item.type === 'string' ? item.type : '';
    if (directType === 'function_call' || directType === 'tool_call') {
      const parsed = this.toToolCall(item);
      if (parsed) {
        calls.push(parsed);
      }
    }

    const nested = Array.isArray(item.tool_calls) ? item.tool_calls : [];
    for (const toolCall of nested) {
      if (toolCall && typeof toolCall === 'object') {
        const parsed = this.toToolCall(toolCall as Record<string, unknown>);
        if (parsed) {
          calls.push(parsed);
        }
      }
    }

    return calls;
  }

  private toToolCall(item: Record<string, unknown>): OpenClawToolCall | null {
    const functionObj = (item.function ?? {}) as Record<string, unknown>;

    const nameCandidate = item.name ?? functionObj.name;
    const name = typeof nameCandidate === 'string' ? nameCandidate : '';
    if (!name) {
      return null;
    }

    const idCandidate = item.call_id ?? item.id ?? randomUUID();
    const id = typeof idCandidate === 'string' ? idCandidate : randomUUID();

    const rawArgs = item.arguments ?? functionObj.arguments ?? {};
    const args = this.parseArguments(rawArgs);

    return {
      id,
      name,
      arguments: args
    };
  }

  private parseArguments(raw: unknown): Record<string, unknown> {
    if (!raw) {
      return {};
    }

    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }

    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  }

  private extractJson(output: string): Record<string, any> {
    const trimmed = output.trim();
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      return {};
    }

    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate) as Record<string, any>;
    } catch {
      return {};
    }
  }
}
