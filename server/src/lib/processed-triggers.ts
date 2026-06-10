// Idempotency keys for anything that must fire at most once per trigger
// (webhook events, scheduled-task occurrences). Shared by the orchestrator
// and the scheduler.
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { processedTriggers } from '../db/schema.js';

export function alreadyProcessed(key: string): boolean {
  return !!db.select().from(processedTriggers).where(eq(processedTriggers.triggerKey, key)).all()[0];
}

export function markProcessed(key: string): void {
  db.insert(processedTriggers).values({ triggerKey: key, createdAt: Date.now() }).onConflictDoNothing().run();
}

/** Release an idempotency key — used when queued work is dropped (task went
 * inert / deps unmet) so the same trigger can legitimately fire again later. */
export function unmarkProcessed(key: string): void {
  db.delete(processedTriggers).where(eq(processedTriggers.triggerKey, key)).run();
}
