import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

dotenv.config();

const app = Fastify({ logger: true });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticRootCandidates = [
  path.join(__dirname, 'public'),
  path.join(__dirname, '../src/public'),
  path.join(process.cwd(), 'src/public'),
  path.join(process.cwd(), 'apps/web/src/public')
];
const staticRoot = staticRootCandidates.find((candidate) => fs.existsSync(candidate)) ?? staticRootCandidates[0];

await app.register(fastifyStatic, {
  root: staticRoot,
  prefix: '/'
});

app.get('/config.js', async (_, reply) => {
  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:3000';
  reply.type('application/javascript');
  return `window.__BRAD_CONFIG__ = { API_BASE_URL: ${JSON.stringify(apiBase)} };`;
});

app.get('/healthz', async () => ({ ok: true, service: 'web' }));

const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? '127.0.0.1';
await app.listen({ port, host });
