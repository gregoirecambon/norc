// Dashboard feedback API (behind apiAuthGuard): pending invites (copy link /
// resend / revoke), submitted feedback (list / delete), and the happiness
// aggregates. Settings (enabled / sample rate / channel) ride /api/settings.

import { Router, type Router as ExpressRouter } from 'express';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedbackInvites, feedbackSubmissions, feedbackToolRatings } from '../db/schema.js';
import { feedbackFormUrl, sendInvite } from '../lib/feedback.js';
import { RUN_TOOL_LABELS, type RunToolKey } from '../lib/run-tools.js';

const router: ExpressRouter = Router();

// GET /api/feedback/invites — pending invites, newest first, with the live URL.
router.get('/invites', (_req, res) => {
  const rows = db.select().from(feedbackInvites).orderBy(desc(feedbackInvites.createdAt)).all();
  res.json({
    invites: rows.map(i => ({
      id: i.id,
      url: feedbackFormUrl(i.token),
      channel: i.channel,
      recipient: i.recipient,
      recipientName: i.recipientName,
      runTitle: i.runTitle,
      agentName: i.agentName,
      runStatus: i.runStatus,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      sentAt: i.sentAt,
    })),
  });
});

// POST /api/feedback/invites/:id/resend — re-deliver over the invite's channel.
router.post('/invites/:id/resend', async (req, res) => {
  const invite = db.select().from(feedbackInvites).where(eq(feedbackInvites.id, req.params['id'] ?? '')).all()[0];
  if (!invite) { res.status(404).json({ error: 'not_found' }); return; }
  if (invite.expiresAt < Date.now()) { res.status(410).json({ error: 'expired' }); return; }
  const result = await sendInvite(invite);
  res.status(result.sent ? 200 : 502).json({ ok: result.sent, error: result.error });
});

// DELETE /api/feedback/invites/:id — revoke a pending invite.
router.delete('/invites/:id', (req, res) => {
  const changes = db.delete(feedbackInvites).where(eq(feedbackInvites.id, req.params['id'] ?? '')).run().changes;
  if (changes === 0) { res.status(404).json({ error: 'not_found' }); return; }
  res.json({ ok: true });
});

// GET /api/feedback/submissions — submitted feedback with their tool ratings.
router.get('/submissions', (_req, res) => {
  const subs = db.select().from(feedbackSubmissions).orderBy(desc(feedbackSubmissions.createdAt)).all();
  const tools = db.select().from(feedbackToolRatings).all();
  const bySubmission = new Map<string, { key: string; label: string; rating: number }[]>();
  for (const t of tools) {
    const list = bySubmission.get(t.submissionId) ?? [];
    list.push({ key: t.toolKey, label: RUN_TOOL_LABELS[t.toolKey as RunToolKey] ?? t.toolKey, rating: t.rating });
    bySubmission.set(t.submissionId, list);
  }
  res.json({
    submissions: subs.map(s => ({
      id: s.id,
      runTitle: s.runTitle,
      agentName: s.agentName,
      rating: s.rating,
      comment: s.comment,
      createdAt: s.createdAt,
      toolRatings: bySubmission.get(s.id) ?? [],
    })),
  });
});

// DELETE /api/feedback/submissions/:id — the cascade wipes its tool ratings.
router.delete('/submissions/:id', (req, res) => {
  const changes = db.delete(feedbackSubmissions).where(eq(feedbackSubmissions.id, req.params['id'] ?? '')).run().changes;
  if (changes === 0) { res.status(404).json({ error: 'not_found' }); return; }
  res.json({ ok: true });
});

// GET /api/feedback/stats — overall happiness + per-tool averages.
router.get('/stats', (_req, res) => {
  const overallRows = db.select({
    rating: feedbackSubmissions.rating,
    count: sql<number>`count(*)`,
  }).from(feedbackSubmissions).groupBy(feedbackSubmissions.rating).all();

  const histogram = [1, 2, 3, 4, 5].map(star => overallRows.find(r => r.rating === star)?.count ?? 0);
  const count = histogram.reduce((a, b) => a + b, 0);
  const avg = count === 0 ? null
    : histogram.reduce((sum, n, i) => sum + n * (i + 1), 0) / count;

  const perTool = db.select({
    key: feedbackToolRatings.toolKey,
    avg: sql<number>`avg(${feedbackToolRatings.rating})`,
    count: sql<number>`count(*)`,
  }).from(feedbackToolRatings).groupBy(feedbackToolRatings.toolKey).all();

  res.json({
    overall: { avg, count, histogram },
    perTool: perTool.map(t => ({
      key: t.key,
      label: RUN_TOOL_LABELS[t.key as RunToolKey] ?? t.key,
      avg: t.avg,
      count: t.count,
    })),
  });
});

export { router as feedbackRouter };
