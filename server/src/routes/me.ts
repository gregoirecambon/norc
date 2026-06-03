import { Router, type Router as ExpressRouter } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentPlatformGrants, platforms } from '../db/schema.js';
import { assertAgentAuth } from '../lib/auth.js';

const router: ExpressRouter = Router();

// GET /api/me/platforms — agent retrieves its granted platform API keys
router.get('/platforms', (req, res) => {
  const agent = assertAgentAuth(req, res);
  if (!agent) return;

  const grants = db.select().from(agentPlatformGrants)
    .where(eq(agentPlatformGrants.agentId, agent.id))
    .all();

  const result = grants.map(g => {
    const platform = db.select().from(platforms).where(eq(platforms.id, g.platformId)).all()[0];
    if (!platform) return null;
    return {
      platformId: platform.id,
      name: platform.name,
      description: platform.description,
      apiKey: platform.apiKey,
      grantedAt: g.grantedAt,
    };
  }).filter(Boolean);

  res.json(result);
});

export { router as meRouter };
