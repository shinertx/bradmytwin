export interface AuthToken {
  personId: string;
  phoneE164: string;
}

export interface OtpPayload {
  phone: string;
  code: string;
}

export interface InboundWebhookResult {
  accepted: boolean;
  reason?: string;
}
