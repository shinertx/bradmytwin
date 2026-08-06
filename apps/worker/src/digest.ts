import crypto from 'node:crypto';

/**
 * Canonical-JSON payload digest, copied from
 * apps/api/src/services/objective-contract.ts so the worker can verify the
 * digest the API wrote at approval-creation time. Keep byte-for-byte
 * compatible with the API copy; dedup into @brad/domain is planned for a
 * follow-up slice (see docs/KERNEL_SLICE_1_BUILD_PLAN_2026-08-03.md).
 */
export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

export function digestPayload(value: unknown): string {
  return sha256(canonicalJson(value));
}
