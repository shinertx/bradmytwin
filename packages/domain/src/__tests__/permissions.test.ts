import { describe, expect, it } from 'vitest';
import { requiresApproval } from '../permissions.js';

describe('permission policy', () => {
  it('requires approval for writes when enabled', () => {
    expect(
      requiresApproval({ readAllowed: true, writeRequiresApproval: true }, 'CREATE_EVENT')
    ).toBe(true);
  });
});
