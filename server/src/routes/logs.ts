import { Router, type Router as ExpressRouter } from 'express';
import { attachSseListener } from '../lib/logger.js';

const router: ExpressRouter = Router();

// GET /api/logs/stream
router.get('/stream', (req, res) => {
  attachSseListener(res);
});

export { router as logsRouter };
