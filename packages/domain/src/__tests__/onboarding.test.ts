import { describe, expect, it } from 'vitest';
import { advanceOnboarding } from '../onboarding.js';

describe('onboarding state transitions', () => {
  it('advances from ASK_NAME when a name is provided', () => {
    const out = advanceOnboarding('ASK_NAME', 'Ben');
    expect(out.nextState).toBe('ASK_CONNECT_CALENDAR');
  });

  it('stays in CONFIRM_READY until READY', () => {
    const out = advanceOnboarding('CONFIRM_READY', 'not yet');
    expect(out.nextState).toBe('CONFIRM_READY');
  });
});
