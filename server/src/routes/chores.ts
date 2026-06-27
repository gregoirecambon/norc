// Dashboard-facing chores API (session-guarded — registered after apiAuthGuard).
// Lists the chores NORC has loaded from disk + how each is set up, so the Chores
// page can render them and host the Notion-sync toggle (the toggle itself flows
// through /api/settings → choresNotionSync).

import { Router, type Router as ExpressRouter } from 'express';
import { loadChores, getChore, choreSyncStates, choresDbInfo, CHORES_VERSION } from '../chores/index.js';
import { getNorcSettingsOrDefault } from '../lib/norc-settings.js';

const router: ExpressRouter = Router();

// GET /api/chores — version, the sync flags, the Chores-DB provisioning state, and a
// summary of every loaded chore (with its Notion sync state when the mirror is on).
router.get('/', async (_req, res) => {
  const s = getNorcSettingsOrDefault();
  const dbInfo = choresDbInfo();
  // Per-chore sync state from Notion — only worth a round-trip when the mirror is on.
  const syncStates = s.choresNotionSync && dbInfo ? await choreSyncStates() : {};
  const chores = loadChores().map(c => ({
    id: c.id,
    description: c.description,
    trigger: c.trigger,
    approval: c.approval,
    minConfidence: c.minConfidence,
    inputs: c.inputs,
    hash: c.hash,
    syncState: syncStates[c.id]?.state ?? (dbInfo ? 'disk-only' : null),
    steps: c.steps.map(st => ({
      number: st.number,
      title: st.title,
      needs: st.needs,
      do: st.do,
      returns: st.returns ?? null,
      after: st.after.map(i => i + 1), // back to the 1-based numbers as written
    })),
  }));
  res.json({
    version: CHORES_VERSION,
    enabled: s.choresEnabled,
    notionSync: s.choresNotionSync,
    choresDbProvisioned: !!dbInfo,
    choresDbUrl: dbInfo?.url ?? null,
    chores,
  });
});

// GET /api/chores/:id — the full parsed chore (raw markdown included).
router.get('/:id', (req, res) => {
  const chore = getChore((req.params as { id: string }).id);
  if (!chore) { res.status(404).json({ error: 'chore_not_found' }); return; }
  res.json(chore);
});

export { router as choresRouter };
