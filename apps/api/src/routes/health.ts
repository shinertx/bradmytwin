import type { FastifyInstance } from 'fastify';
import { pool } from '../services/db.js';
import { redis } from '../services/redis.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => {
    await pool.query('SELECT 1');
    await redis.ping();
    return { ok: true, service: 'api' };
  });
}
