import { Router, type Router as ExpressRouter } from 'express';
import { getVersionInfo } from '../lib/version-check.js';

const router: ExpressRouter = Router();

// GET /api/version — { current, latest, updateAvailable, url }
router.get('/', (_req, res) => {
  res.json(getVersionInfo());
});

export { router as versionRouter };
