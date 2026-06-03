import { Router, type Router as ExpressRouter } from 'express';
import { attachEventListener } from '../lib/events.js';

const router: ExpressRouter = Router();

router.get('/stream', (_req, res) => {
  attachEventListener(res);
});

export { router as eventsRouter };
