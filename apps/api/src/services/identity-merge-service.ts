import { randomToken } from '../utils/hash.js';
import { redis } from './redis.js';
import { query } from './db.js';

export class IdentityMergeService {
  async start(sourcePersonId: string, targetPhoneE164: string): Promise<string> {
    const rows = await query<{ id: string }>('SELECT id FROM persons WHERE phone_e164 = $1 AND phone_verified = true', [
      targetPhoneE164
    ]);

    if (!rows[0]) {
      throw new Error('target_person_not_found');
    }

    const mergeToken = randomToken(20);
    await redis.setex(
      `identity-merge:${mergeToken}`,
      10 * 60,
      JSON.stringify({ sourcePersonId, targetPersonId: rows[0].id })
    );
    return mergeToken;
  }

  async confirm(mergeToken: string): Promise<{ sourcePersonId: string; targetPersonId: string } | null> {
    const key = `identity-merge:${mergeToken}`;
    const payload = await redis.get(key);
    if (!payload) {
      return null;
    }

    await redis.del(key);
    return JSON.parse(payload) as { sourcePersonId: string; targetPersonId: string };
  }

  async mergeChannelIdentities(sourcePersonId: string, targetPersonId: string): Promise<void> {
    await query('UPDATE channel_identities SET person_id = $1 WHERE person_id = $2', [targetPersonId, sourcePersonId]);
    await query('UPDATE auth_identities SET person_id = $1 WHERE person_id = $2', [targetPersonId, sourcePersonId]);
    await query('UPDATE messages SET person_id = $1 WHERE person_id = $2', [targetPersonId, sourcePersonId]);
    await query('UPDATE threads SET person_id = $1 WHERE person_id = $2', [targetPersonId, sourcePersonId]);
    await query('UPDATE approval_requests SET person_id = $1 WHERE person_id = $2', [targetPersonId, sourcePersonId]);
    await query('UPDATE tool_invocations SET person_id = $1 WHERE person_id = $2', [targetPersonId, sourcePersonId]);
    await query('UPDATE audit_logs SET person_id = $1 WHERE person_id = $2', [targetPersonId, sourcePersonId]);
    await query('DELETE FROM persons WHERE id = $1', [sourcePersonId]);
  }
}
