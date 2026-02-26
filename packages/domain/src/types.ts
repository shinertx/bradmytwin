export type ChannelType = 'SMS' | 'WHATSAPP' | 'TELEGRAM' | 'WEB';

export type OnboardingState =
  | 'ASK_NAME'
  | 'ASK_CONNECT_CALENDAR'
  | 'ASK_CONNECT_EMAIL'
  | 'CONFIRM_READY'
  | 'ACTIVE';

export type WriteActionType =
  | 'SEND_EMAIL'
  | 'CREATE_EVENT'
  | 'UPDATE_EVENT'
  | 'SUBMIT_FORM';

export interface Person {
  id: string;
  preferredName: string | null;
  phoneE164: string | null;
  phoneVerified: boolean;
  onboardingState: OnboardingState;
  timezone: string | null;
  emailSignatureStyle: string | null;
}

export interface ChannelIdentity {
  personId: string;
  channel: ChannelType;
  externalUserKey: string;
  phoneE164Nullable: string | null;
  verifiedPhone: boolean;
}

export interface PermissionSet {
  readAllowed: boolean;
  writeRequiresApproval: boolean;
}

export interface InboundMessage {
  channel: ChannelType;
  externalUserKey: string;
  text: string;
  providerMessageId: string;
  phoneE164?: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  channel: ChannelType;
  externalUserKey: string;
  text: string;
}

export interface ToolRequest {
  id: string;
  toolName: string;
  isWrite: boolean;
  actionType?: WriteActionType;
  payload: Record<string, unknown>;
}

export interface OpenClawResponse {
  assistantText: string;
  toolRequests: ToolRequest[];
  toolResults?: Record<string, unknown>[];
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OpenClawToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface OpenClawToolOutput {
  callId: string;
  output: Record<string, unknown>;
}

export interface OpenClawTurnInput {
  runId: string;
  sessionId: string;
  userId: string;
  inputText?: string;
  previousResponseId?: string;
  toolOutputs?: OpenClawToolOutput[];
  tools: ToolDefinition[];
  model: string;
  temperature: number;
  maxTokens: number;
  metadata?: Record<string, unknown>;
}

export interface OpenClawTurnResult {
  runId: string;
  sessionId: string;
  responseId: string;
  assistantText: string;
  toolCalls: OpenClawToolCall[];
  error?: string;
}
