// Historical statistics (behind apiAuthGuard). The aggregate logic lives in
// lib/stats-view.ts, shared with the machine surface (/api/ext/stats).

import { Router, type Router as ExpressRouter } from 'express';
import { buildStats, STATS_WINDOWS } from '../lib/stats-view.js';

const router: ExpressRouter = Router();

// GET /api/stats?days=7|30|90 — one payload, ~6 aggregate queries.
router.get('/', async (req, res) => {
  const days = STATS_WINDOWS.includes(Number(req.query['days'])) ? Number(req.query['days']) : 30;
  res.json(await buildStats(days));
});

export { router as statsRouter };
