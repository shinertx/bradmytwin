import type { ChannelType, OnboardingState, Person } from '@brad/domain';
import { randomUUID } from 'node:crypto';
import { query } from './db.js';

interface PersonRow {
  id: string;
  preferred_name: string | null;
  phone_e164: string | null;
  phone_verified: boolean;
  onboarding_state: OnboardingState;
  timezone: string | null;
  email_signature_style: string | null;
}

function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    preferredName: row.preferred_name,
    phoneE164: row.phone_e164,
    phoneVerified: row.phone_verified,
    onboardingState: row.onboarding_state,
    timezone: row.timezone,
    emailSignatureStyle: row.email_signature_style
  };
}

export class PersonService {
  async findById(personId: string): Promise<Person | null> {
    const rows = await query<PersonRow>('SELECT * FROM persons WHERE id = $1', [personId]);
    return rows[0] ? toPerson(rows[0]) : null;
  }

  async findByPhone(phoneE164: string): Promise<Person | null> {
    const rows = await query<PersonRow>('SELECT * FROM persons WHERE phone_e164 = $1', [phoneE164]);
    return rows[0] ? toPerson(rows[0]) : null;
  }

  async resolveOrCreateByChannel(input: {
    channel: ChannelType;
    externalUserKey: string;
    phoneE164?: string;
    verifiedPhone: boolean;
  }): Promise<Person> {
    const identityRows = await query<{ person_id: string }>(
      `SELECT person_id FROM channel_identities
       WHERE channel = $1 AND external_user_key = $2`,
      [input.channel, input.externalUserKey]
    );

    if (identityRows[0]) {
      const person = await this.findById(identityRows[0].person_id);
      if (!person) {
        throw new Error('identity_person_missing');
      }
      return person;
    }

    const existingByPhone = input.phoneE164 ? await this.findByPhone(input.phoneE164) : null;
    const personId = existingByPhone?.id ?? randomUUID();

    if (!existingByPhone) {
      await query(
        `INSERT INTO persons (id, phone_e164, phone_verified, onboarding_state)
         VALUES ($1, $2, $3, $4)`,
        [
          personId,
          input.phoneE164 ?? null,
          input.verifiedPhone,
          input.verifiedPhone ? 'ASK_NAME' : 'ASK_NAME'
        ]
      );

      await query(
        `INSERT INTO permissions (person_id, resource, can_read, requires_approval_for_write)
         VALUES ($1, 'default', true, true)`,
        [personId]
      );

      await query(
        `INSERT INTO skills_enabled (person_id, skill, enabled)
         VALUES ($1, 'conversation', true),
                ($1, 'calendar', true),
                ($1, 'email', true),
                ($1, 'browser', true)`,
        [personId]
      );
    }

    await query(
      `INSERT INTO channel_identities (
         person_id, channel, external_user_key, phone_e164_nullable, verified_phone
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel, external_user_key) DO NOTHING`,
      [personId, input.channel, input.externalUserKey, input.phoneE164 ?? null, input.verifiedPhone]
    );

    const person = await this.findById(personId);
    if (!person) {
      throw new Error('failed_to_resolve_person');
    }
    return person;
  }

  async markPhoneVerified(personId: string, phoneE164: string): Promise<void> {
    await query(
      `UPDATE persons SET phone_e164 = $2, phone_verified = true, updated_at = now() WHERE id = $1`,
      [personId, phoneE164]
    );
  }

  async upsertChannelIdentity(input: {
    personId: string;
    channel: ChannelType;
    externalUserKey: string;
    phoneE164?: string;
    verifiedPhone: boolean;
  }): Promise<void> {
    await query(
      `INSERT INTO channel_identities (
         person_id, channel, external_user_key, phone_e164_nullable, verified_phone
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel, external_user_key)
       DO UPDATE SET person_id = excluded.person_id,
                     phone_e164_nullable = excluded.phone_e164_nullable,
                     verified_phone = excluded.verified_phone,
                     updated_at = now()`,
      [
        input.personId,
        input.channel,
        input.externalUserKey,
        input.phoneE164 ?? null,
        input.verifiedPhone
      ]
    );
  }

  async updateName(personId: string, preferredName: string): Promise<void> {
    await query(
      'UPDATE persons SET preferred_name = $2, updated_at = now() WHERE id = $1',
      [personId, preferredName]
    );
  }

  async updateOnboardingState(personId: string, state: OnboardingState): Promise<void> {
    await query('UPDATE persons SET onboarding_state = $2, updated_at = now() WHERE id = $1', [personId, state]);
  }

  async listSkills(personId: string): Promise<string[]> {
    const rows = await query<{ skill: string }>(
      `SELECT skill FROM skills_enabled WHERE person_id = $1 AND enabled = true`,
      [personId]
    );
    return rows.map((r) => r.skill);
  }

  async getPermissionPolicy(personId: string): Promise<{ readAllowed: boolean; writeRequiresApproval: boolean }> {
    const rows = await query<{
      can_read: boolean;
      requires_approval_for_write: boolean;
    }>(
      `SELECT can_read, requires_approval_for_write
       FROM permissions
       WHERE person_id = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [personId]
    );

    if (!rows[0]) {
      return { readAllowed: true, writeRequiresApproval: true };
    }

    return {
      readAllowed: rows[0].can_read,
      writeRequiresApproval: rows[0].requires_approval_for_write
    };
  }
}
