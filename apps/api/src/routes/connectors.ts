import type { FastifyInstance } from 'fastify';
import { ConnectorService } from '../services/connector-service.js';
import { env } from '../config/env.js';

const connectorService = new ConnectorService();

function encodeState(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeState(state: string): Record<string, string> {
  return JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as Record<string, string>;
}

export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/link/google/start', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const body = req.body as { scope: 'calendar' | 'email' };
    const scope = body?.scope ?? 'calendar';

    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_OAUTH_REDIRECT_URI) {
      return reply.send({
        authUrl: `${env.WEB_BASE_URL}/connect/google?scope=${scope}&person_id=${user.personId}`,
        note: 'google_oauth_not_configured_using_placeholder'
      });
    }

    const state = encodeState({ personId: user.personId, scope });
    const oauthScope = scope === 'calendar'
      ? 'https://www.googleapis.com/auth/calendar'
      : 'https://www.googleapis.com/auth/gmail.modify';

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', env.GOOGLE_OAUTH_REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', oauthScope);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);

    return reply.send({ authUrl: authUrl.toString() });
  });

  app.get('/auth/link/google/callback', async (req, reply) => {
    const query = req.query as { state: string; code?: string; scope?: 'calendar' | 'email'; error?: string };
    if (!query.state) {
      return reply.status(400).send({ error: 'missing_state' });
    }

    if (query.error) {
      return reply.redirect(`${env.WEB_BASE_URL}/connect/error?provider=google&reason=${encodeURIComponent(query.error)}`);
    }

    if (!query.code) {
      return reply.status(400).send({ error: 'missing_code' });
    }

    const state = decodeState(query.state);
    const personId = state.personId;
    const scope = (state.scope as 'calendar' | 'email') ?? query.scope ?? 'calendar';

    try {
      const token = await connectorService.exchangeGoogleCodeForTokens(query.code, env.GOOGLE_OAUTH_REDIRECT_URI ?? `${env.APP_BASE_URL}/auth/link/google/callback`);
      await connectorService.upsertGoogleConnectorTokens({
        personId,
        scope,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresInSeconds: token.expires_in
      });
      return reply.redirect(`${env.WEB_BASE_URL}/connect/success?provider=google&scope=${scope}`);
    } catch (error) {
      req.log.error({ error }, 'google_connector_callback_failed');
      return reply.redirect(`${env.WEB_BASE_URL}/connect/error?provider=google&scope=${scope}`);
    }
  });

  app.get('/connectors/status', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const connectors = await connectorService.listStatus(user.personId);
    return reply.send({ connectors });
  });

  app.post('/auth/link/apple/start', { preHandler: [app.authenticate] }, async (_req, reply) => {
    return reply.send({
      authUrl: `${env.WEB_BASE_URL}/connect/apple`,
      note: 'apple_linking_stubbed_for_mvp_scaffold'
    });
  });
}
