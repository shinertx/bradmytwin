import { describe, expect, it } from 'vitest';
import { eventField, findEventId, findEventWithMarker, formatBuzzMessage, recipientPubkeys } from '../protocol.js';

describe('Buzz bridge protocol', () => {
  it('formats a durable marker and exactly one requested agent mention', () => {
    const content = formatBuzzMessage({
      outboxId: 'outbox-1',
      payload: { sender: 'system', type: 'DELEGATE', recipients: ['codex'], body: 'Review this.' },
      mentions: { codex: '@Codex', claude: '@Claude' }
    });
    expect(content).toContain('@Codex');
    expect(content).not.toContain('@Claude');
    expect(content).toContain('brad-outbox:outbox-1');
  });

  it('finds nested event IDs and fields', () => {
    expect(findEventId({ data: { event: { event_id: 'evt-1' } } })).toBe('evt-1');
    expect(eventField({ event: { content: 'hello' } }, ['content'])).toBe('hello');
  });

  it('reconciles a prior publish only from the expected signer', () => {
    const result = { events: [
      { id: 'wrong', pubkey: 'other', content: '<!-- brad-outbox:abc -->' },
      { id: 'right', pubkey: 'bridge', content: '<!-- brad-outbox:abc -->' }
    ] };
    expect(findEventWithMarker(result, 'brad-outbox:abc', 'bridge')?.eventId).toBe('right');
    expect(findEventWithMarker(result, 'brad-outbox:abc', 'missing')).toBeUndefined();
  });

  it('addresses only registered specialist identities and removes duplicates', () => {
    expect(recipientPubkeys(['codex', 'unknown', 'codex', 'claude'], {
      codex: 'codex-pubkey',
      claude: 'claude-pubkey'
    })).toEqual(['codex-pubkey', 'claude-pubkey']);
  });
});
