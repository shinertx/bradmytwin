import type { FastifyInstance } from 'fastify';
import { PersonService } from '../services/person-service.js';
import { OtpService } from '../services/otp-service.js';
import { gatewayForChannel } from '../adapters/channel-gateway.js';
import { IdentityMergeService } from '../services/identity-merge-service.js';

const personService = new PersonService();
const otpService = new OtpService();
const identityMergeService = new IdentityMergeService();

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/otp/start', async (req, reply) => {
    const body = req.body as { phone: string };
    if (!body?.phone) {
      return reply.status(400).send({ error: 'phone_required' });
    }

    const otp = await otpService.issue(body.phone);
    await gatewayForChannel('SMS').sendOutbound({
      channel: 'SMS',
      externalUserKey: body.phone,
      text: `Your Brad verification code is ${otp}`
    });

    return reply.send({ ok: true });
  });

  app.post('/auth/otp/verify', async (req, reply) => {
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
    await personService.upsertChannelIdentity({
      personId: person.id,
      channel: 'WEB',
      externalUserKey: person.id,
      phoneE164: body.phone,
      verifiedPhone: true
    });

    const token = await reply.jwtSign({ personId: person.id, phoneE164: body.phone });
    return reply.send({ token, personId: person.id });
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
