import type { OpenClawResponse } from '@brad/domain';
export interface OpenClawExecuteInput {
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
}
export declare class OpenClawClient {
    private readonly baseUrl;
    private readonly apiKey;
    constructor(baseUrl: string | undefined, apiKey: string | undefined);
    execute(input: OpenClawExecuteInput): Promise<OpenClawResponse>;
}
