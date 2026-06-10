import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../lib/notion-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/notion-client.js')>()),
  notionGet: vi.fn(),
  notionPatch: vi.fn(async () => ({})),
}));

import { eq } from 'drizzle-orm';
import { runMigrations, db } from '../db/client.js';
import { pendingSelfChanges, norcSettings, notionIntegration } from '../db/schema.js';
import { notionPatch } from '../lib/notion-client.js';
import {
  createPendingChange, attachProposalComment, findPendingByDiscussion, resolveChange,
  expireStaleChanges, parseApprovalReply, renderSelfChangeDiff, applySelfChange,
  describeProposedValue,
} from '../lib/self-changes.js';
import { getNorcSettingsOrDefault } from '../lib/norc-settings.js';

beforeAll(() => { runMigrations(); });

beforeEach(() => {
  db.delete(pendingSelfChanges).run();
  db.delete(norcSettings).run();
  db.delete(notionIntegration).run();
  vi.mocked(notionPatch).mockClear();
});

const mkChange = (kind: Parameters<typeof createPendingChange>[0]['kind'], payload: Record<string, unknown>) =>
  createPendingChange({ kind, payload, diffText: 'diff', pageId: 'page-1', proposedByUserId: 'user-greg' });

describe('parseApprovalReply', () => {
  it.each([
    ['approve', 'approve'],
    ['Approved!', 'approve'],
    ['lgtm', 'approve'],
    ['✅', 'approve'],
    ['reject', 'reject'],
    ['Rejected, thanks', 'reject'],
    ['cancel that', 'reject'],
    ['❌', 'reject'],
    ['hmm let me think', 'unclear'],
    ['approve... no wait, reject', 'unclear'],
    ['', 'unclear'],
  ])('"%s" → %s', (text, expected) => {
    expect(parseApprovalReply(text)).toBe(expected);
  });
});

describe('pending-change state machine', () => {
  it('creates a pending row and finds it by discussion id once attached', () => {
    const c = mkChange('autoRouteThreshold', { value: 0.9 });
    expect(c.status).toBe('pending');
    expect(findPendingByDiscussion('d-1')).toBeNull();
    attachProposalComment(c.id, 'cm-1', 'd-1');
    expect(findPendingByDiscussion('d-1')?.id).toBe(c.id);
  });

  it('a new proposal of the same kind supersedes the older pending one', () => {
    const first = mkChange('autoRouteThreshold', { value: 0.8 });
    attachProposalComment(first.id, 'cm-1', 'd-1');
    const second = mkChange('autoRouteThreshold', { value: 0.9 });
    attachProposalComment(second.id, 'cm-2', 'd-2');

    expect(findPendingByDiscussion('d-1')).toBeNull(); // superseded
    expect(findPendingByDiscussion('d-2')?.id).toBe(second.id);
    const rows = db.select().from(pendingSelfChanges).all();
    expect(rows.find(r => r.id === first.id)?.status).toBe('superseded');
  });

  it('a different kind does NOT supersede', () => {
    const a = mkChange('autoRouteThreshold', { value: 0.8 });
    attachProposalComment(a.id, 'cm-1', 'd-1');
    const b = mkChange('autoProposeEnabled', { value: true });
    attachProposalComment(b.id, 'cm-2', 'd-2');
    expect(findPendingByDiscussion('d-1')?.id).toBe(a.id);
    expect(findPendingByDiscussion('d-2')?.id).toBe(b.id);
  });

  it('resolveChange closes the row with the verdict + author', () => {
    const c = mkChange('autoProposeEnabled', { value: true });
    resolveChange(c.id, 'approved', 'user-greg');
    const row = db.select().from(pendingSelfChanges).all()[0]!;
    expect(row.status).toBe('approved');
    expect(row.resolvedByUserId).toBe('user-greg');
    expect(row.resolvedAt).not.toBeNull();
  });

  it('expireStaleChanges expires only pending rows past the TTL', () => {
    const fresh = mkChange('autoProposeEnabled', { value: true });
    const old = mkChange('autoRouteThreshold', { value: 0.5 });
    db.update(pendingSelfChanges)
      .set({ createdAt: Date.now() - 8 * 24 * 3600_000 })
      .where(eq(pendingSelfChanges.id, old.id))
      .run();

    expect(expireStaleChanges()).toBe(1);
    const byId = new Map(db.select().from(pendingSelfChanges).all().map(r => [r.id, r.status]));
    expect(byId.get(old.id)).toBe('expired');
    expect(byId.get(fresh.id)).toBe('pending');
  });
});

describe('renderSelfChangeDiff', () => {
  it('renders before → after and truncates long values', () => {
    const d = renderSelfChangeDiff('orchestratorSystemPrompt', 'x'.repeat(3000), 'short');
    expect(d).toContain('change: orchestratorSystemPrompt');
    expect(d).toContain('— before —');
    expect(d).toContain('…(truncated)');
    expect(d).toContain('— after —\nshort');
    expect(renderSelfChangeDiff('autoRouteThreshold', '', '0.9')).toContain('(not set)');
  });
});

describe('describeProposedValue', () => {
  it('renders scalar payloads and norcOrgPage fields', () => {
    expect(describeProposedValue('autoRouteThreshold', { value: 0.9 })).toBe('0.9');
    expect(describeProposedValue('norcOrgPage', { specialty: 'ops', systemPrompt: 'be bold' }))
      .toBe('Specialty: ops\nSystem Prompt: be bold');
  });
});

describe('applySelfChange', () => {
  const apply = (kind: Parameters<typeof createPendingChange>[0]['kind'], payload: Record<string, unknown>) =>
    applySelfChange('api-key', mkChange(kind, payload));

  it('sets and resets the orchestrator system prompt', async () => {
    await apply('orchestratorSystemPrompt', { value: 'Think about cost first.' });
    expect(getNorcSettingsOrDefault().orchestratorSystemPrompt).toBe('Think about cost first.');
    await apply('orchestratorSystemPrompt', { value: '' });
    expect(getNorcSettingsOrDefault().orchestratorSystemPrompt).toBeNull();
  });

  it('clamps autoRouteThreshold to 0..1 and intervalHours to 1..24', async () => {
    await apply('autoRouteThreshold', { value: 1.5 });
    expect(getNorcSettingsOrDefault().autoRouteThreshold).toBe(1);
    await apply('autoProposeIntervalHours', { value: 99 });
    expect(getNorcSettingsOrDefault().autoProposeIntervalHours).toBe(24);
  });

  it('toggles autoProposeEnabled', async () => {
    await apply('autoProposeEnabled', { value: true });
    expect(getNorcSettingsOrDefault().autoProposeEnabled).toBe(true);
  });

  it('throws on invalid payloads (change stays pending at the caller)', async () => {
    await expect(apply('autoRouteThreshold', { value: 'high' })).rejects.toThrow(/numeric/);
    await expect(apply('autoProposeEnabled', { value: 'yes' })).rejects.toThrow(/boolean/);
    await expect(apply('orchestratorSystemPrompt', {})).rejects.toThrow(/string/);
  });

  it('patches the Org DB page for norcOrgPage (and throws without a page)', async () => {
    await expect(apply('norcOrgPage', { specialty: 'ops' })).rejects.toThrow(/no Org DB page/);

    db.insert(notionIntegration).values({
      id: 'i1', apiKey: 'k', status: 'active', workspaceStatus: 'provisioned',
      norcOrgPageId: 'org-norc', createdAt: Date.now(), updatedAt: Date.now(),
    }).run();
    const summary = await apply('norcOrgPage', { specialty: 'orchestration & ops' });
    expect(summary).toContain('profile');
    expect(notionPatch).toHaveBeenCalledWith('api-key', '/pages/org-norc', expect.objectContaining({
      properties: expect.objectContaining({ 'Specialty': expect.anything() }),
    }));
  });
});
