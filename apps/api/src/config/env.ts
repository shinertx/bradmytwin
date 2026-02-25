import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@postgres:5432/brad'),
  REDIS_URL: z.string().default('redis://redis:6379'),
  JWT_SECRET: z.string().min(16).default('dev-super-secret-change-me'),
  APP_BASE_URL: z.string().default('http://localhost:3000'),
  WEB_BASE_URL: z.string().default('http://localhost:5173'),
  OPENCLAW_MODE: z.enum(['stub', 'http', 'cli']).default('stub'),
  OPENCLAW_URL: z.string().optional(),
  OPENCLAW_API_KEY: z.string().optional(),
  OPENCLAW_CLI_BIN: z.string().default('openclaw'),
  OPENCLAW_CLI_AGENT_ID: z.string().optional(),
  OPENCLAW_CLI_TIMEOUT_MS: z.coerce.number().default(90000),
  OPENCLAW_MODEL_DEFAULT: z.string().default('gpt-4.1'),
  OPENCLAW_MODEL_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_SMS_FROM: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().optional(),
  KMS_KEY_NAME: z.string().optional(),
  BROWSER_ALLOWLIST: z.string().default('example.com')
});

export const env = schema.parse(process.env);
