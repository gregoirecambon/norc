import { randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { registrationTokens } from '../db/schema.js';
import { isNull } from 'drizzle-orm';

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export async function ensureActiveToken(): Promise<string> {
  const existing = db
    .select()
    .from(registrationTokens)
    .where(isNull(registrationTokens.usedAt))
    .all();

  if (existing.length > 0 && existing[0]) return existing[0].token;

  const token = generateToken();
  db.insert(registrationTokens).values({
    id: randomUUID(),
    token,
    createdAt: Date.now(),
  }).run();

  return token;
}

export function consumeToken(token: string, agentName: string): boolean {
  const row = db
    .select()
    .from(registrationTokens)
    .where(isNull(registrationTokens.usedAt))
    .all()
    .find(r => r.token === token);

  if (!row) return false;

  db.update(registrationTokens)
    .set({ usedAt: Date.now(), usedByAgent: agentName })
    .where(isNull(registrationTokens.usedAt))
    .run();

  const newToken = generateToken();
  db.insert(registrationTokens).values({
    id: randomUUID(),
    token: newToken,
    createdAt: Date.now(),
  }).run();

  return true;
}
