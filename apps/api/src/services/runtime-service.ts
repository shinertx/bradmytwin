import { randomUUID } from 'node:crypto';
import { query } from './db.js';
import { redis } from './redis.js';

export interface RuntimeContext {
  sessionId: string;
  responseId?: string;
}

const TTL_SECONDS = 10 * 60;

export class RuntimeService {
  async ensureRuntimeContext(
    personId: string,
    createContext: () => Promise<RuntimeContext>
  ): Promise<RuntimeContext> {
    const key = this.key(personId);
    const existing = await redis.get(key);
    if (existing) {
      const parsed = this.parseContext(existing);
      await redis.expire(key, TTL_SECONDS);
      await this.upsertSessionRow(personId, parsed.sessionId, parsed.responseId);
      return parsed;
    }

    const context = await createContext();
    await redis.setex(key, TTL_SECONDS, JSON.stringify(context));
    await this.upsertSessionRow(personId, context.sessionId, context.responseId);
    return context;
  }

  async updateResponseId(personId: string, responseId: string): Promise<void> {
    const key = this.key(personId);
    const existing = await redis.get(key);
    const parsed = existing ? this.parseContext(existing) : { sessionId: randomUUID() };
    parsed.responseId = responseId;
    await redis.setex(key, TTL_SECONDS, JSON.stringify(parsed));
    await this.upsertSessionRow(personId, parsed.sessionId, parsed.responseId);
  }

  async touchRuntime(personId: string): Promise<void> {
    await redis.expire(this.key(personId), TTL_SECONDS);
  }

  async ensureRuntimeId(personId: string, createRuntime: () => Promise<string>): Promise<string> {
    const context = await this.ensureRuntimeContext(personId, async () => ({
      sessionId: await createRuntime()
    }));
    return context.sessionId;
  }

  async rotateRuntimeId(personId: string): Promise<string> {
    const sessionId = randomUUID();
    await redis.setex(this.key(personId), TTL_SECONDS, JSON.stringify({ sessionId }));
    await this.upsertSessionRow(personId, sessionId, undefined);
    return sessionId;
  }

  private key(personId: string): string {
    return `runtime:person:${personId}`;
  }

  private parseContext(raw: string): RuntimeContext {
    try {
      const parsed = JSON.parse(raw) as RuntimeContext;
      if (parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string') {
        return parsed;
      }
    } catch {
      // keep fallback below
    }

    // Backward compatibility for old runtime key shape that stored session id as raw string.
    return { sessionId: raw };
  }

  private async upsertSessionRow(personId: string, sessionId: string, responseId?: string): Promise<void> {
    await query(
      `WITH updated AS (
         UPDATE runtime_sessions
         SET person_id = $2,
             status = 'ACTIVE',
             last_active_at = now(),
             expires_at = now() + interval '10 minutes',
             last_response_id = COALESCE($4, runtime_sessions.last_response_id)
         WHERE openclaw_session_id = $3
         RETURNING id
       )
       INSERT INTO runtime_sessions (id, person_id, status, last_active_at, expires_at, openclaw_session_id, last_response_id)
       SELECT $1, $2, 'ACTIVE', now(), now() + interval '10 minutes', $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM updated)`,
      [randomUUID(), personId, sessionId, responseId ?? null]
    );
  }
}
