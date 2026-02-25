export declare class TwilioClient {
    private readonly accountSid?;
    private readonly authToken?;
    private readonly fromPhone?;
    private readonly whatsappFrom?;
    constructor(accountSid?: string | undefined, authToken?: string | undefined, fromPhone?: string | undefined, whatsappFrom?: string | undefined);
    sendSms(to: string, body: string): Promise<void>;
    sendWhatsApp(to: string, body: string): Promise<void>;
    validateSignature(url: string, params: Record<string, string>, signature?: string): boolean;
    private sendMessage;
}
