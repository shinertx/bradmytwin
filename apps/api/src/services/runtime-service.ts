import { randomUUID } from 'node:crypto';
import { redis } from './redis.js';

export class RuntimeService {
  async ensureRuntimeId(personId: string, createRuntime: () => Promise<string>): Promise<string> {
    const key = `runtime:person:${personId}`;
    const existing = await redis.get(key);
    if (existing) {
      await redis.expire(key, 10 * 60);
      return existing;
    }

    const runtimeId = await createRuntime();
    await redis.setex(key, 10 * 60, runtimeId);
    return runtimeId;
  }

  async rotateRuntimeId(personId: string): Promise<string> {
    const key = `runtime:person:${personId}`;
    const runtimeId = randomUUID();
    await redis.setex(key, 10 * 60, runtimeId);
    return runtimeId;
  }

  async touchRuntime(personId: string): Promise<void> {
    await redis.expire(`runtime:person:${personId}`, 10 * 60);
  }
}
