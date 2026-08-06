export interface BuzzOutboxPayload {
  threadId?: string;
  objectiveId?: string;
  sender?: string;
  recipients?: string[];
  type?: string;
  body?: string;
}

export function notificationRecipients(payload: BuzzOutboxPayload): string[] {
  return payload.type === 'DELEGATE' ? payload.recipients ?? [] : [];
}

export function findEventId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  for (const key of ['id', 'event_id', 'eventId']) {
    if (typeof row[key] === 'string') return row[key] as string;
  }
  for (const child of Object.values(row)) {
    const nested = findEventId(child);
    if (nested) return nested;
  }
  return undefined;
}

export function eventList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  if (!value || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  for (const key of ['messages', 'events', 'items', 'data', 'results']) {
    if (Array.isArray(row[key])) return eventList(row[key]);
  }
  return [];
}

export function eventField(event: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) if (typeof event[name] === 'string') return event[name] as string;
  const nested = event.event;
  return nested && typeof nested === 'object' ? eventField(nested as Record<string, unknown>, names) : undefined;
}

export function formatBuzzMessage(input: {
  outboxId: string;
  payload: BuzzOutboxPayload;
  mentions: Partial<Record<'codex' | 'claude', string>>;
}): string {
  const recipientMentions = notificationRecipients(input.payload).map((recipient) => {
    if (recipient === 'codex' || recipient === 'claude') return input.mentions[recipient] ?? '';
    return '';
  }).filter(Boolean).join(' ');
  return [
    recipientMentions,
    `**${input.payload.sender ?? 'system'} · ${input.payload.type ?? 'SYSTEM'}**`,
    input.payload.body ?? '',
    `<!-- brad-outbox:${input.outboxId} brad-thread:${input.payload.threadId ?? ''} brad-objective:${input.payload.objectiveId ?? ''} -->`
  ].filter(Boolean).join('\n\n');
}

export function recipientPubkeys(
  recipients: string[] = [],
  pubkeys: Partial<Record<'codex' | 'claude', string>>
): string[] {
  return [...new Set(recipients.map((recipient) => {
    if (recipient === 'codex' || recipient === 'claude') return pubkeys[recipient];
    return undefined;
  }).filter((pubkey): pubkey is string => Boolean(pubkey)))];
}

export function findEventWithMarker(
  value: unknown,
  marker: string,
  expectedPubkey?: string
): { eventId: string; content: string } | undefined {
  for (const event of eventList(value)) {
    const eventId = eventField(event, ['id', 'event_id', 'eventId']);
    const content = eventField(event, ['content', 'body', 'text']);
    const author = eventField(event, ['pubkey', 'author_pubkey', 'authorPubkey']);
    if (eventId && content?.includes(marker) && (!expectedPubkey || author === expectedPubkey)) {
      return { eventId, content };
    }
  }
  return undefined;
}
