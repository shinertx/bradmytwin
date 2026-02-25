import { randomOtp } from '../utils/hash.js';
import { redis } from './redis.js';

export class OtpService {
  async issue(phoneE164: string): Promise<string> {
    const otp = randomOtp();
    await redis.setex(`otp:phone:${phoneE164}`, 5 * 60, otp);
    return otp;
  }

  async verify(phoneE164: string, code: string): Promise<boolean> {
    const key = `otp:phone:${phoneE164}`;
    const saved = await redis.get(key);
    if (!saved || saved !== code) {
      return false;
    }
    await redis.del(key);
    return true;
  }
}
