import { describe, expect, it } from 'vitest';
import { classifySignal } from '../ea-control-service.js';

describe('classifySignal', () => {
  it('turns urgent deadline signals into tasks', () => {
    const out = classifySignal({
      sourceType: 'EMAIL',
      subject: 'Court deadline due today',
      bodyPreview: 'Please review and send this before the deadline.'
    });

    expect(out).toEqual({
      classification: 'ACTION',
      priority: 'URGENT',
      category: 'email',
      createTask: true
    });
  });

  it('routes scheduling language to calendar work', () => {
    const out = classifySignal({
      sourceType: 'SMS',
      bodyPreview: 'Can you reschedule the appointment tomorrow?'
    });

    expect(out.classification).toBe('SCHEDULE');
    expect(out.category).toBe('calendar');
    expect(out.createTask).toBe(true);
  });

  it('does not create work from obvious promos', () => {
    const out = classifySignal({
      sourceType: 'EMAIL',
      subject: 'Sale ends tonight',
      bodyPreview: 'Unsubscribe any time.'
    });

    expect(out.classification).toBe('IGNORE');
    expect(out.priority).toBe('LOW');
    expect(out.createTask).toBe(false);
  });
});
