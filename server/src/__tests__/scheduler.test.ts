import { describe, it, expect } from 'vitest';
import { nextOccurrence } from '../lib/scheduler.js';
import { isInertTaskStatus, TASK_STATUS_OPTIONS } from '../lib/notion-provision.js';

describe('nextOccurrence', () => {
  const at = (iso: string) => new Date(iso);

  it('Daily adds one day, preserving time-of-day', () => {
    const n = nextOccurrence(at('2026-06-07T09:30:00.000Z'), 'Daily', 0);
    expect(n?.toISOString()).toBe('2026-06-08T09:30:00.000Z');
  });

  it('Weekly adds seven days', () => {
    const n = nextOccurrence(at('2026-06-07T00:00:00.000Z'), 'Weekly', 0);
    expect(n?.toISOString()).toBe('2026-06-14T00:00:00.000Z');
  });

  it('Monthly rolls to the next month', () => {
    const n = nextOccurrence(at('2026-01-15T08:00:00.000Z'), 'Monthly', 0);
    expect(n?.getMonth()).toBe(1); // February (0-indexed)
  });

  it('Weekdays skips the weekend (Fri → Mon)', () => {
    // 2026-06-05 is a Friday → next weekday is Monday 2026-06-08
    const n = nextOccurrence(at('2026-06-05T12:00:00.000Z'), 'Weekdays', 0);
    expect(n?.getUTCDay()).toBe(1); // Monday
    expect(n?.toISOString().slice(0, 10)).toBe('2026-06-08');
  });

  it('every-N-days wins over the preset', () => {
    const n = nextOccurrence(at('2026-06-07T00:00:00.000Z'), 'Daily', 3);
    expect(n?.toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });

  it('None (or unknown) yields no further occurrence', () => {
    expect(nextOccurrence(at('2026-06-07T00:00:00.000Z'), 'None', 0)).toBeNull();
    expect(nextOccurrence(at('2026-06-07T00:00:00.000Z'), 'whatever', 0)).toBeNull();
  });
});

describe('isInertTaskStatus', () => {
  it('empty / unset / whitespace is inert (a half-drafted Notion row)', () => {
    expect(isInertTaskStatus('')).toBe(true);
    expect(isInertTaskStatus('  ')).toBe(true);
    expect(isInertTaskStatus(null)).toBe(true);
    expect(isInertTaskStatus(undefined)).toBe(true);
  });

  it('Draft and Proposed are inert (parked by a human / awaiting validation)', () => {
    expect(isInertTaskStatus('Draft')).toBe(true);
    expect(isInertTaskStatus('Proposed')).toBe(true);
  });

  it('active lifecycle statuses are not inert', () => {
    expect(isInertTaskStatus('Backlog')).toBe(false);
    expect(isInertTaskStatus('In Progress')).toBe(false);
    expect(isInertTaskStatus('Done')).toBe(false);
    expect(isInertTaskStatus('Failed')).toBe(false);
  });

  it('Queued is NOT inert (NORC owns it — the work is accepted, just waiting)', () => {
    expect(isInertTaskStatus('Queued')).toBe(false);
  });

  it('every inert status is a provisioned select option (except empty)', () => {
    const opts = new Set<string>(TASK_STATUS_OPTIONS);
    for (const s of ['Draft', 'Proposed']) expect(opts.has(s)).toBe(true);
  });

  it("'Queued' is a provisioned select option", () => {
    expect(new Set<string>(TASK_STATUS_OPTIONS).has('Queued')).toBe(true);
  });
});
