import { redis } from './redis.js';

export class LockService {
  async acquire(personId: string, ttlSeconds = 20): Promise<boolean> {
    const key = `lock:person:${personId}`;
    const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async release(personId: string): Promise<void> {
    await redis.del(`lock:person:${personId}`);
  }
}
