import { Router, type Router as ExpressRouter } from 'express';
import { readSkillDoc, NORC_SKILL_VERSION } from '../lib/skill.js';
import { norcBaseUrl as norcUrl } from '../lib/base-url.js';

const router: ExpressRouter = Router();

// GET /api/skill — the durable orchestration protocol (markdown).
router.get('/', (_req, res) => {
  try {
    const md = readSkillDoc(norcUrl());
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('X-NORC-Skill-Version', String(NORC_SKILL_VERSION));
    res.send(md);
  } catch {
    res.status(500).json({ error: 'skill_unavailable' });
  }
});

// GET /api/skill/version — lightweight version check for agents.
router.get('/version', (_req, res) => {
  res.json({ version: NORC_SKILL_VERSION });
});

export { router as skillRouter };
