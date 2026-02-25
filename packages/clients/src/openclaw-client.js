import { randomUUID } from 'node:crypto';
export class OpenClawClient {
    baseUrl;
    apiKey;
    constructor(baseUrl, apiKey) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
    }
    async execute(input) {
        if (!this.baseUrl) {
            const toolRequests = /schedule|calendar/i.test(input.inputText)
                ? [
                    {
                        id: randomUUID(),
                        toolName: 'calendar.create_event',
                        isWrite: true,
                        actionType: 'CREATE_EVENT',
                        payload: { raw: input.inputText }
                    }
                ]
                : [];
            return {
                assistantText: toolRequests.length
                    ? 'I can schedule that. I need your approval before creating the event.'
                    : `Brad twin heard: ${input.inputText}`,
                toolRequests
            };
        }
        const res = await fetch(`${this.baseUrl}/v1/twin/execute`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
            },
            body: JSON.stringify(input)
        });
        if (!res.ok) {
            return {
                assistantText: 'I could not reach the orchestration engine right now.',
                toolRequests: [],
                error: `openclaw_http_${res.status}`
            };
        }
        return (await res.json());
    }
}
//# sourceMappingURL=openclaw-client.js.map