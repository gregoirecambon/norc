import { describe, it, expect } from 'vitest';
import { assembleWithBudget, type Section } from '../lib/context-assembler.js';

// assembleWithBudget is the shared priority-truncation helper the co-CEO auto-propose
// loop relies on to keep its context bounded at portfolio scale. Lock its contract.
describe('assembleWithBudget', () => {
  const sec = (text: string, priority: number, order: number): Section => ({ text, priority, order });

  it('keeps everything when under budget and preserves emission order', () => {
    const out = assembleWithBudget([sec('B', 1, 1), sec('A', 0, 0)], 1000);
    expect(out).toBe('A\n\nB'); // sorted back to original order, not priority order
  });

  it('never drops a priority-0 section even when the budget is exceeded', () => {
    const big = 'x'.repeat(500);
    const out = assembleWithBudget([sec(big, 1, 0), sec('CONTRACT', 0, 1)], 50);
    expect(out).toContain('CONTRACT');
  });

  it('truncates the overflowing section when >300 chars of room remain', () => {
    const keep = 'k'.repeat(100);          // priority 1, fits
    const overflow = 'o'.repeat(5000);     // priority 2, overflows
    const out = assembleWithBudget([sec(keep, 1, 0), sec(overflow, 2, 1)], 600);
    expect(out).toContain('…(truncated for length)');
    expect(out).toContain(keep);
    expect(out.length).toBeLessThanOrEqual(600 + 40); // budget + the marker tail
  });

  it('drops a section entirely when ≤300 chars of room remain', () => {
    const keep = 'k'.repeat(290);
    const overflow = 'o'.repeat(500);
    const out = assembleWithBudget([sec(keep, 1, 0), sec(overflow, 2, 1)], 300);
    expect(out).toContain(keep);
    expect(out).not.toContain('o'.repeat(10)); // the overflow section was dropped, not truncated
    expect(out).not.toContain('truncated');
  });
});
