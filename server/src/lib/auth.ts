import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents } from '../db/schema.js';

export function getAgentFromBearer(req: Request): typeof agents.$inferSelect | null {
  const auth = (req.headers['authorization'] ?? '').toString();
  const secret = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!secret) return null;
  const row = db.select().from(agents).where(eq(agents.agentSecret, secret)).all()[0];
  return row ?? null;
}

export function assertAgentAuth(req: Request, res: Response): typeof agents.$inferSelect | null {
  const agent = getAgentFromBearer(req);
  if (!agent) {
    res.status(401).json({ error: 'unauthorized', hint: 'Pass Authorization: Bearer <agentSecret>' });
    return null;
  }
  return agent;
}
