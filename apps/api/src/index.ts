import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rawBody from 'fastify-raw-body';
import { env } from './config/env.js';
import { webhookRoutes } from './routes/webhooks.js';
import { authRoutes } from './routes/auth.js';
import { connectorRoutes } from './routes/connectors.js';
import { approvalRoutes } from './routes/approvals.js';
import { webChatRoutes } from './routes/web-chat.js';
import { healthRoutes } from './routes/health.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { personId: string; phoneE164: string };
    user: { personId: string; phoneE164: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
  }
}

async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true
  });
  await app.register(formbody);
  await app.register(jwt, { secret: env.JWT_SECRET });

  app.decorate('authenticate', async function authenticate(request, reply) {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ error: 'unauthorized' });
    }
  });

  await app.register(healthRoutes);
  await app.register(webhookRoutes);
  await app.register(authRoutes);
  await app.register(connectorRoutes);
  await app.register(approvalRoutes);
  await app.register(webChatRoutes);

  return app;
}

const app = await buildServer();
await app.listen({ port: env.PORT, host: '0.0.0.0' });
