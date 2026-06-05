import { Router, type Router as ExpressRouter } from 'express';
import { attachSseListener, clearLogs } from '../lib/logger.js';

const router: ExpressRouter = Router();

// GET /api/logs/stream
router.get('/stream', (req, res) => {
  attachSseListener(res);
});

// DELETE /api/logs — wipe persisted logs and clear every connected viewer.
router.delete('/', (_req, res) => {
  clearLogs();
  res.json({ cleared: true });
});

export { router as logsRouter };
