import { env } from '../config/env.js';
import { query } from './db.js';

export interface ModelProfile {
  model: string;
  temperature: number;
  maxTokens: number;
}

export class ModelProfileService {
  async getOrCreate(personId: string): Promise<ModelProfile> {
    const rows = await query<{
      model_name: string;
      temperature: number;
      max_tokens: number;
    }>(
      `SELECT model_name, temperature, max_tokens
       FROM model_profiles
       WHERE person_id = $1`,
      [personId]
    );

    if (rows[0]) {
      return {
        model: rows[0].model_name,
        temperature: Number(rows[0].temperature),
        maxTokens: rows[0].max_tokens
      };
    }

    await query(
      `INSERT INTO model_profiles (person_id, model_name, temperature, max_tokens)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (person_id) DO NOTHING`,
      [personId, env.OPENCLAW_MODEL_DEFAULT, env.OPENCLAW_MODEL_TEMPERATURE, 1500]
    );

    return {
      model: env.OPENCLAW_MODEL_DEFAULT,
      temperature: env.OPENCLAW_MODEL_TEMPERATURE,
      maxTokens: 1500
    };
  }
}
