import crypto from 'node:crypto';

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(length = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

export function randomOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
