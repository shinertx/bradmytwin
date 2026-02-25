import type { FastifyInstance } from 'fastify';
import { PersonService } from '../services/person-service.js';
import { OtpService } from '../services/otp-service.js';
import { gatewayForChannel } from '../adapters/channel-gateway.js';
import { IdentityMergeService } from '../services/identity-merge-service.js';
import { randomToken } from '../utils/hash.js';
import { redis } from '../services/redis.js';
import { GoogleLoginService } from '../services/google-login-service.js';
import { AuditService } from '../services/audit-service.js';
import { env } from '../config/env.js';

const personService = new PersonService();
const otpService = new OtpService();
const identityMergeService = new IdentityMergeService();
const googleLoginService = new GoogleLoginService();
const auditService = new AuditService();

const authRateLimit = {
  rateLimit: {
    max: 20,
    timeWindow: '1 minute'
  }
};

function googleStateKey(state: string): string {
  return `auth:google:state:${state}`;
}

function googleExchangeKey(exchangeCode: string): string {
  return `auth:google:exchange:${exchangeCode}`;
}

async function issueOtp(phone: string): Promise<void> {
  const otp = await otpService.issue(phone);
  await gatewayForChannel('SMS').sendOutbound({
    channel: 'SMS',
    externalUserKey: phone,
    text: `Your BuddyClaw verification code is ${otp}`
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auth/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const person = await personService.findById(user.personId);
    if (!person) {
      return reply.status(404).send({ error: 'person_not_found' });
    }
    return reply.send({
      personId: person.id,
      preferredName: person.preferredName,
      phoneVerified: person.phoneVerified,
      phoneE164: person.phoneE164,
      onboardingState: person.onboardingState
    });
  });

  app.get('/auth/login/google/start', { config: authRateLimit }, async (req, reply) => {
    if (!googleLoginService.isConfigured()) {
      return reply.status(503).send({ error: 'google_login_not_configured' });
    }

    const query = req.query as { mode?: 'json'; return_to?: string };
    const state = randomToken(12);
    await redis.setex(googleStateKey(state), 10 * 60, JSON.stringify({ returnTo: query.return_to ?? '/' }));

    const authUrl = googleLoginService.buildAuthUrl(state);
    if (query.mode === 'json') {
      return reply.send({ authUrl });
    }

    return reply.redirect(authUrl);
  });

  app.get('/auth/login/google/callback', { config: authRateLimit }, async (req, reply) => {
    const query = req.query as { state?: string; code?: string; error?: string };

    if (query.error) {
      return reply.redirect(`${env.WEB_BASE_URL}/auth-callback.html?status=error&reason=google_denied`);
    }

    if (!query.state || !query.code) {
      return reply.redirect(`${env.WEB_BASE_URL}/auth-callback.html?status=error&reason=missing_code_or_state`);
    }

    const statePayload = await redis.get(googleStateKey(query.state));
    await redis.del(googleStateKey(query.state));
    if (!statePayload) {
      return reply.redirect(`${env.WEB_BASE_URL}/auth-callback.html?status=error&reason=invalid_state`);
    }

    try {
      const profile = await googleLoginService.exchangeCodeForProfile(query.code);

      let personId = await personService.findPersonIdByAuthIdentity('GOOGLE', profile.providerUserId);
      if (!personId) {
        personId = await personService.createPerson({ verifiedPhone: false });
        await personService.seedDefaults(personId);
      }

      await personService.upsertAuthIdentity({
        personId,
        provider: 'GOOGLE',
        providerUserId: profile.providerUserId,
        email: profile.email
      });

      await personService.upsertChannelIdentity({
        personId,
        channel: 'WEB',
        externalUserKey: personId,
        verifiedPhone: false
      });

      const exchangeCode = randomToken(16);
      await redis.setex(
        googleExchangeKey(exchangeCode),
        60,
        JSON.stringify({ personId, email: profile.email ?? null })
      );

      await auditService.log({
        personId,
        eventType: 'AUTH_GOOGLE_LOGIN_SUCCESS',
        entityType: 'auth_identity',
        entityId: `GOOGLE:${profile.providerUserId}`,
        metadata: {
          email: profile.email ?? null,
          emailVerified: profile.emailVerified
        }
      });

      await auditService.log({
        personId,
        eventType: 'AUTH_GOOGLE_EXCHANGE_ISSUED',
        entityType: 'auth_exchange',
        entityId: exchangeCode,
        metadata: { ttlSeconds: 60 }
      });

      return reply.redirect(`${env.WEB_BASE_URL}/auth-callback.html?code=${encodeURIComponent(exchangeCode)}`);
    } catch (error) {
      req.log.error({ error }, 'google_login_callback_failed');
      return reply.redirect(`${env.WEB_BASE_URL}/auth-callback.html?status=error&reason=callback_failed`);
    }
  });

  app.post('/auth/login/google/exchange', { config: authRateLimit }, async (req, reply) => {
    const body = req.body as { code?: string };
    if (!body?.code) {
      return reply.status(400).send({ error: 'exchange_code_required' });
    }

    const key = googleExchangeKey(body.code);
    const payload = await redis.get(key);
    if (!payload) {
      return reply.status(404).send({ error: 'exchange_code_invalid_or_expired' });
    }

    await redis.del(key);

    const parsed = JSON.parse(payload) as { personId: string; email?: string | null };
    const person = await personService.findById(parsed.personId);
    if (!person) {
      return reply.status(404).send({ error: 'person_not_found' });
    }

    const token = await reply.jwtSign({ personId: person.id, phoneE164: person.phoneE164 ?? undefined });

    await auditService.log({
      personId: person.id,
      eventType: 'AUTH_GOOGLE_EXCHANGE_CONSUMED',
      entityType: 'auth_exchange',
      entityId: body.code,
      metadata: {}
    });

    return reply.send({
      token,
      personId: person.id,
      phoneVerified: person.phoneVerified,
      email: parsed.email ?? null
    });
  });

  app.post('/auth/otp/start', { config: authRateLimit }, async (req, reply) => {
    const body = req.body as { phone: string };
    if (!body?.phone) {
      return reply.status(400).send({ error: 'phone_required' });
    }

    await issueOtp(body.phone);
    return reply.send({ ok: true });
  });

  app.post('/auth/phone/start', { config: authRateLimit }, async (req, reply) => {
    const body = req.body as { phone: string };
    if (!body?.phone) {
      return reply.status(400).send({ error: 'phone_required' });
    }

    await issueOtp(body.phone);
    return reply.send({ ok: true });
  });

  app.post('/auth/otp/verify', { config: authRateLimit }, async (req, reply) => {
    const body = req.body as { phone: string; code: string; pendingPersonId?: string };
    const valid = await otpService.verify(body.phone, body.code);
    if (!valid) {
      return reply.status(401).send({ error: 'invalid_otp' });
    }

    const person =
      (await personService.findByPhone(body.phone)) ??
      (await personService.resolveOrCreateByChannel({
        channel: 'SMS',
        externalUserKey: body.phone,
        phoneE164: body.phone,
        verifiedPhone: true
      }));

    await personService.markPhoneVerified(person.id, body.phone);
    await personService.upsertAuthIdentity({
      personId: person.id,
      provider: 'PHONE_OTP',
      providerUserId: body.phone
    });
    await personService.upsertChannelIdentity({
      personId: person.id,
      channel: 'WEB',
      externalUserKey: person.id,
      phoneE164: body.phone,
      verifiedPhone: true
    });

    const token = await reply.jwtSign({ personId: person.id, phoneE164: body.phone });
    await auditService.log({
      personId: person.id,
      eventType: 'AUTH_PHONE_VERIFIED',
      entityType: 'person',
      entityId: person.id,
      metadata: { channel: 'WEB', source: 'otp_verify' }
    });
    return reply.send({ token, personId: person.id });
  });

  app.post('/auth/phone/verify', { preHandler: [app.authenticate], config: authRateLimit }, async (req, reply) => {
    const user = req.user as { personId: string };
    const body = req.body as { phone: string; code: string };
    if (!body?.phone || !body?.code) {
      return reply.status(400).send({ error: 'phone_and_code_required' });
    }

    const valid = await otpService.verify(body.phone, body.code);
    if (!valid) {
      return reply.status(401).send({ error: 'invalid_otp' });
    }

    let targetPersonId = user.personId;
    const existingByPhone = await personService.findByPhone(body.phone);
    if (existingByPhone && existingByPhone.id !== user.personId) {
      await identityMergeService.mergeChannelIdentities(user.personId, existingByPhone.id);
      targetPersonId = existingByPhone.id;
    }

    await personService.markPhoneVerified(targetPersonId, body.phone);
    await personService.upsertAuthIdentity({
      personId: targetPersonId,
      provider: 'PHONE_OTP',
      providerUserId: body.phone
    });
    await personService.upsertChannelIdentity({
      personId: targetPersonId,
      channel: 'WEB',
      externalUserKey: targetPersonId,
      phoneE164: body.phone,
      verifiedPhone: true
    });

    const person = await personService.findById(targetPersonId);
    if (!person) {
      return reply.status(404).send({ error: 'person_not_found' });
    }

    const token = await reply.jwtSign({ personId: targetPersonId, phoneE164: body.phone });
    await auditService.log({
      personId: targetPersonId,
      eventType: 'AUTH_PHONE_VERIFIED',
      entityType: 'person',
      entityId: targetPersonId,
      metadata: {
        channel: 'WEB',
        source: 'phone_verify_linked',
        mergedFromPersonId: targetPersonId === user.personId ? null : user.personId
      }
    });

    return reply.send({
      ok: true,
      token,
      personId: targetPersonId,
      mergedFromPersonId: targetPersonId === user.personId ? null : user.personId
    });
  });

  app.post('/identity/merge/start', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const body = req.body as { targetPhoneE164: string };
    if (!body?.targetPhoneE164) {
      return reply.status(400).send({ error: 'target_phone_required' });
    }

    const mergeToken = await identityMergeService.start(user.personId, body.targetPhoneE164);
    return reply.send({ mergeToken });
  });

  app.post('/identity/merge/confirm', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = req.body as { mergeToken: string };
    const payload = await identityMergeService.confirm(body.mergeToken);
    if (!payload) {
      return reply.status(404).send({ error: 'merge_token_invalid' });
    }

    await identityMergeService.mergeChannelIdentities(payload.sourcePersonId, payload.targetPersonId);
    return reply.send({ ok: true, personId: payload.targetPersonId });
  });
}
