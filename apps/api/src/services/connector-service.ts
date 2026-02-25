import { KmsEnvelope } from '@brad/clients';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { query } from './db.js';

const kms = new KmsEnvelope(env.KMS_KEY_NAME);

export class ConnectorService {
  async upsertGoogleConnector(personId: string, scope: 'calendar' | 'email', token: string): Promise<void> {
    const encrypted = await kms.encrypt(token);
    await query(
      `INSERT INTO connectors (
         id, person_id, provider, scope, token_ciphertext, refresh_ciphertext, expires_at, status
       ) VALUES ($1,$2,'google',$3,$4,$5,now() + interval '45 minutes','CONNECTED')
       ON CONFLICT (person_id, provider, scope)
       DO UPDATE SET token_ciphertext = excluded.token_ciphertext,
                     refresh_ciphertext = excluded.refresh_ciphertext,
                     status = 'CONNECTED',
                     updated_at = now()`,
      [
        randomUUID(),
        personId,
        scope,
        JSON.stringify(encrypted),
        JSON.stringify(encrypted)
      ]
    );
  }

  async listConnectorRefs(personId: string): Promise<string[]> {
    const rows = await query<{ provider: string; scope: string }>(
      `SELECT provider, scope FROM connectors WHERE person_id = $1 AND status = 'CONNECTED'`,
      [personId]
    );

    return rows.map((r) => `${r.provider}:${r.scope}`);
  }
}
