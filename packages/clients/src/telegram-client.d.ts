export declare class TelegramClient {
    private readonly botToken?;
    private readonly webhookSecret?;
    constructor(botToken?: string | undefined, webhookSecret?: string | undefined);
    validateSecret(secret?: string): boolean;
    sendMessage(chatId: string, text: string): Promise<void>;
}
