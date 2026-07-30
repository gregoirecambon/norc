// Public API documentation — the shareable, self-describing reference for the
// /api/ext machine surface. Served unauthenticated (like /api/skill) so an
// operator can hand the URL to an integrator; examples are templated with the
// live NORC URL. Canonical file: server/assets/API.md (mirrored in the repo as
// docs/API.md — a test keeps them in sync).

import { Router, type Router as ExpressRouter } from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { norcBaseUrl } from '../lib/base-url.js';

const router: ExpressRouter = Router();

// '../../assets/…' resolves the same from src/routes (dev) and dist/routes (built).
const DOC_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../assets/API.md',
);

// GET /api/docs — the API reference, markdown, live-URL templated.
router.get('/', (_req, res) => {
  try {
    const md = readFileSync(DOC_PATH, 'utf8').replace(/{{NORC_URL}}/g, norcBaseUrl());
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(md);
  } catch {
    res.status(500).json({ error: 'docs_unavailable' });
  }
});

export { router as docsRouter };
