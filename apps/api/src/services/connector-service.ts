import { KmsEnvelope, type CipherBundle } from '@brad/clients';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { query } from './db.js';

const kms = new KmsEnvelope(env.KMS_KEY_NAME);

interface ConnectorRow {
  id: string;
  person_id: string;
  provider: string;
  scope: string;
  token_ciphertext: unknown;
  refresh_ciphertext: unknown;
  expires_at: string | null;
  status: 'PENDING' | 'CONNECTED' | 'ERROR' | 'REVOKED';
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export interface ConnectorStatus {
  provider: string;
  scope: string;
  status: string;
  expiresAt: string | null;
  isExpired: boolean;
}

export class ConnectorService {
  async exchangeGoogleCodeForTokens(code: string, redirectUri: string): Promise<GoogleTokenResponse> {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new Error('google_oauth_not_configured');
    }

    const params = new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`google_token_exchange_failed:${res.status}:${body}`);
    }

    const token = (await res.json()) as GoogleTokenResponse;
    if (!token.access_token) {
      throw new Error('google_access_token_missing');
    }

    return token;
  }

  async upsertGoogleConnectorTokens(input: {
    personId: string;
    scope: 'calendar' | 'email';
    accessToken: string;
    refreshToken?: string;
    expiresInSeconds?: number;
  }): Promise<void> {
    const expiresIn = input.expiresInSeconds ?? 3600;
    const expiresAtIso = new Date(Date.now() + expiresIn * 1000).toISOString();

    const existing = await this.getConnectorRow(input.personId, 'google', input.scope);
    const refreshTokenToStore = input.refreshToken || (await this.decryptOptional(existing?.refresh_ciphertext));

    const encryptedAccess = await kms.encrypt(input.accessToken);
    const encryptedRefresh = refreshTokenToStore ? await kms.encrypt(refreshTokenToStore) : null;

    await query(
      `INSERT INTO connectors (
         id, person_id, provider, scope, token_ciphertext, refresh_ciphertext, expires_at, status
       ) VALUES ($1,$2,'google',$3,$4,$5,$6,'CONNECTED')
       ON CONFLICT (person_id, provider, scope)
       DO UPDATE SET token_ciphertext = excluded.token_ciphertext,
                     refresh_ciphertext = COALESCE(excluded.refresh_ciphertext, connectors.refresh_ciphertext),
                     expires_at = excluded.expires_at,
                     status = 'CONNECTED',
                     updated_at = now()`,
      [
        existing?.id ?? randomUUID(),
        input.personId,
        input.scope,
        JSON.stringify(encryptedAccess),
        encryptedRefresh ? JSON.stringify(encryptedRefresh) : null,
        expiresAtIso
      ]
    );
  }

  async upsertGoogleConnector(personId: string, scope: 'calendar' | 'email', token: string): Promise<void> {
    await this.upsertGoogleConnectorTokens({
      personId,
      scope,
      accessToken: token,
      expiresInSeconds: 60 * 30
    });
  }

  async listConnectorRefs(personId: string): Promise<string[]> {
    const rows = await query<{ provider: string; scope: string }>(
      `SELECT provider, scope
       FROM connectors
       WHERE person_id = $1
         AND status = 'CONNECTED'
         AND (expires_at IS NULL OR expires_at > now() - interval '5 minutes')`,
      [personId]
    );

    return rows.map((r) => `${r.provider}:${r.scope}`);
  }

  async listStatus(personId: string): Promise<ConnectorStatus[]> {
    const rows = await query<ConnectorRow>(
      `SELECT id, person_id, provider, scope, token_ciphertext, refresh_ciphertext, expires_at, status
       FROM connectors
       WHERE person_id = $1
       ORDER BY provider, scope`,
      [personId]
    );

    const now = Date.now();
    return rows.map((row) => {
      const expiresMs = row.expires_at ? new Date(row.expires_at).getTime() : null;
      return {
        provider: row.provider,
        scope: row.scope,
        status: row.status,
        expiresAt: row.expires_at,
        isExpired: expiresMs !== null ? expiresMs <= now : false
      };
    });
  }

  async getGoogleAccessToken(personId: string, scope: 'calendar' | 'email'): Promise<string> {
    const connector = await this.getConnectorRow(personId, 'google', scope);
    if (!connector || connector.status !== 'CONNECTED') {
      throw new Error(`google_connector_missing:${scope}`);
    }

    const accessToken = await this.decryptRequired(connector.token_ciphertext);
    const expiresAtMs = connector.expires_at ? new Date(connector.expires_at).getTime() : 0;
    const now = Date.now();

    if (expiresAtMs > now + 60_000) {
      return accessToken;
    }

    const refreshToken = await this.decryptOptional(connector.refresh_ciphertext);
    if (!refreshToken) {
      throw new Error(`google_refresh_token_missing:${scope}`);
    }

    const refreshed = await this.refreshGoogleToken(refreshToken);
    await this.upsertGoogleConnectorTokens({
      personId,
      scope,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || refreshToken,
      expiresInSeconds: refreshed.expires_in
    });

    return refreshed.access_token;
  }

  private async refreshGoogleToken(refreshToken: string): Promise<GoogleTokenResponse> {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new Error('google_oauth_not_configured');
    }

    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`google_token_refresh_failed:${res.status}:${body}`);
    }

    const token = (await res.json()) as GoogleTokenResponse;
    if (!token.access_token) {
      throw new Error('google_refreshed_access_token_missing');
    }

    return token;
  }

  private async getConnectorRow(
    personId: string,
    provider: string,
    scope: string
  ): Promise<ConnectorRow | null> {
    const rows = await query<ConnectorRow>(
      `SELECT id, person_id, provider, scope, token_ciphertext, refresh_ciphertext, expires_at, status
       FROM connectors
       WHERE person_id = $1 AND provider = $2 AND scope = $3
       LIMIT 1`,
      [personId, provider, scope]
    );

    return rows[0] ?? null;
  }

  private async decryptRequired(value: unknown): Promise<string> {
    const parsed = this.parseCipherBundle(value);
    if (!parsed) {
      throw new Error('connector_cipher_bundle_missing');
    }

    return await kms.decrypt(parsed);
  }

  private async decryptOptional(value: unknown): Promise<string | null> {
    const parsed = this.parseCipherBundle(value);
    if (!parsed) {
      return null;
    }

    return await kms.decrypt(parsed);
  }

  private parseCipherBundle(value: unknown): CipherBundle | null {
    if (!value) {
      return null;
    }

    let candidate: unknown = value;
    if (typeof candidate === 'string') {
      try {
        candidate = JSON.parse(candidate) as unknown;
      } catch {
        return null;
      }
    }

    if (!candidate || typeof candidate !== 'object') {
      return null;
    }

    const typed = candidate as Record<string, unknown>;
    if (
      typeof typed.wrappedDek !== 'string' ||
      typeof typed.iv !== 'string' ||
      typeof typed.authTag !== 'string' ||
      typeof typed.ciphertext !== 'string'
    ) {
      return null;
    }

    return {
      wrappedDek: typed.wrappedDek,
      iv: typed.iv,
      authTag: typed.authTag,
      ciphertext: typed.ciphertext
    };
  }
}
