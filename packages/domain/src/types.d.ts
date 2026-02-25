export type ChannelType = 'SMS' | 'WHATSAPP' | 'TELEGRAM' | 'WEB';
export type OnboardingState = 'ASK_NAME' | 'ASK_CONNECT_CALENDAR' | 'ASK_CONNECT_EMAIL' | 'CONFIRM_READY' | 'ACTIVE';
export type WriteActionType = 'SEND_EMAIL' | 'CREATE_EVENT' | 'UPDATE_EVENT' | 'SUBMIT_FORM';
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
