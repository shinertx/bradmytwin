const E164_REGEX = /^\+[1-9]\d{7,14}$/;

export function normalizePhoneE164Candidate(raw?: string): string | undefined {
  if (!raw) {
    return;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return;
  }

  const startsWithPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) {
    return;
  }

  let candidate: string;
  if (startsWithPlus) {
    candidate = `+${digits}`;
  } else if (digits.length === 10) {
    candidate = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    candidate = `+${digits}`;
  } else {
    return;
  }

  return E164_REGEX.test(candidate) ? candidate : undefined;
}
