// The public feedback form — the link humans click from a Slack DM or email.
// Mounted OUTSIDE /api (like /icons and /webhooks) so it needs no dashboard
// session: the opaque invite token in the path is the whole credential. Links
// self-destruct: lazy expiry on access + the hourly sweep, and a submission
// deletes the invite (structural idempotency — a second POST finds no token).

import { Router, type Router as ExpressRouter } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedbackInvites, feedbackSubmissions, feedbackToolRatings } from '../db/schema.js';
import { randomUUID } from 'node:crypto';
import { emitLog } from '../lib/logger.js';
import type { FeedbackInvite } from '../lib/feedback.js';

const router: ExpressRouter = Router();

const SubmitBody = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
  toolRatings: z.array(z.object({
    key: z.string().min(1).max(40),
    rating: z.number().int().min(1).max(5),
  })).max(3).optional(),
});

/** Resolve a live invite; expired ones are deleted on sight (self-destruct). */
function liveInvite(token: string): FeedbackInvite | null {
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  const invite = db.select().from(feedbackInvites).where(eq(feedbackInvites.token, token)).all()[0];
  if (!invite) return null;
  if (invite.expiresAt < Date.now()) {
    db.delete(feedbackInvites).where(eq(feedbackInvites.id, invite.id)).run();
    return null;
  }
  return invite;
}

// GET /feedback/:token — the form (or the tombstone page).
router.get('/:token', (req, res) => {
  const invite = liveInvite(req.params['token'] ?? '');
  res.status(invite ? 200 : 410).type('html').send(invite ? formPage(invite) : expiredPage());
});

// POST /feedback/:token — one submission, then the invite is gone.
router.post('/:token', (req, res) => {
  const invite = liveInvite(req.params['token'] ?? '');
  if (!invite) { res.status(410).json({ error: 'expired' }); return; }
  const parsed = SubmitBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_body' }); return; }
  const { rating, comment, toolRatings } = parsed.data;

  // Only questions that were actually asked count.
  let askedKeys: Set<string>;
  try { askedKeys = new Set((JSON.parse(invite.questionsJson) as { key: string }[]).map(q => q.key)); }
  catch { askedKeys = new Set(); }

  const submissionId = randomUUID();
  db.transaction(tx => {
    tx.insert(feedbackSubmissions).values({
      id: submissionId,
      runId: invite.runId,
      runTitle: invite.runTitle,
      agentId: invite.agentId,
      agentName: invite.agentName,
      rating,
      comment: comment?.trim() || null,
      createdAt: Date.now(),
    }).run();
    for (const t of toolRatings ?? []) {
      if (!askedKeys.has(t.key)) continue;
      tx.insert(feedbackToolRatings).values({
        id: randomUUID(), submissionId, toolKey: t.key, rating: t.rating,
      }).run();
    }
    tx.delete(feedbackInvites).where(eq(feedbackInvites.id, invite.id)).run();
  });

  emitLog(`feedback received: ${rating}★ for run ${invite.runId} (${invite.runTitle ?? 'untitled'})`);
  res.json({ ok: true });
});

// ── The pages: one self-contained HTML string each, no assets, no session ──

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SHELL_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, 'Segoe UI', Inter, sans-serif; background: #f7f7f5; color: #37352f;
         display: flex; justify-content: center; padding: 48px 16px; min-height: 100vh; }
  .card { background: #fff; border: 1px solid #e6e4df; border-radius: 12px; padding: 32px 28px;
          max-width: 460px; width: 100%; box-shadow: 0 1px 3px rgba(0,0,0,.05); height: fit-content; }
  .brand { font-size: 18px; font-weight: 700; letter-spacing: -.3px; margin-bottom: 20px; }
  h1 { font-size: 17px; font-weight: 650; line-height: 1.4; margin-bottom: 6px; }
  .sub { font-size: 13px; color: #787671; margin-bottom: 24px; }
  .q { font-size: 13.5px; font-weight: 600; margin: 18px 0 8px; }
  .stars { display: flex; gap: 4px; flex-direction: row-reverse; justify-content: flex-end; }
  .stars input { display: none; }
  .stars label { font-size: 26px; color: #d9d7d2; cursor: pointer; transition: color .1s; padding: 0 1px; }
  .stars label:hover, .stars label:hover ~ label,
  .stars input:checked ~ label { color: #f5a623; }
  textarea { width: 100%; border: 1px solid #e6e4df; border-radius: 8px; padding: 10px 12px; font: inherit;
             font-size: 13.5px; min-height: 84px; resize: vertical; margin-top: 6px; }
  textarea:focus { outline: 2px solid #5645d4; outline-offset: -1px; border-color: transparent; }
  button { background: #5645d4; color: #fff; border: 0; border-radius: 8px; padding: 10px 22px;
           font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 24px; width: 100%; }
  button:disabled { opacity: .5; cursor: default; }
  .err { color: #c0392b; font-size: 13px; margin-top: 12px; display: none; }
  .fine { font-size: 12px; color: #787671; margin-top: 16px; text-align: center; }
`;

function starGroup(name: string): string {
  // Reversed order + CSS sibling selector = hover/checked highlight.
  return `<div class="stars">${[5, 4, 3, 2, 1].map(v =>
    `<input type="radio" id="${name}-${v}" name="${name}" value="${v}"><label for="${name}-${v}" title="${v} star${v > 1 ? 's' : ''}">★</label>`,
  ).join('')}</div>`;
}

function formPage(invite: FeedbackInvite): string {
  let questions: { key: string; label: string }[] = [];
  try { questions = JSON.parse(invite.questionsJson) as { key: string; label: string }[]; } catch { /* none */ }
  const title = esc(invite.runTitle ?? 'your task');
  const agent = esc(invite.agentName ?? 'An agent');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>How was it? — NORC</title>
<style>${SHELL_CSS}</style>
</head><body>
<form class="card" id="f">
  <div class="brand">NORC</div>
  <h1>How did “${title}” go?</h1>
  <div class="sub">${agent} finished this run${invite.runStatus === 'done' ? '' : ` (it ended <strong>${esc(invite.runStatus ?? '')}</strong>)`}. Your rating helps improve the team.</div>
  <div class="q">Overall, how was this run?</div>
  ${starGroup('rating')}
  ${questions.map(q => `<div class="q">${esc(q.label)}</div>${starGroup(`tool-${esc(q.key)}`)}`).join('')}
  <div class="q">Anything to add? <span style="font-weight:400;color:#787671">(optional)</span></div>
  <textarea name="comment" maxlength="2000" placeholder="What worked, what didn't…"></textarea>
  <button type="submit">Send feedback</button>
  <div class="err" id="err">Something went wrong — please try again.</div>
  <div class="fine">Takes ~20 seconds · This link expires ${new Date(invite.expiresAt).toISOString().slice(0, 10)}</div>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector('button'), err = document.getElementById('err');
  const rating = f.querySelector('input[name="rating"]:checked');
  if (!rating) { err.textContent = 'Pick an overall star rating first.'; err.style.display = 'block'; return; }
  const toolRatings = [];
  for (const el of f.querySelectorAll('input[type=radio]:checked')) {
    if (el.name.startsWith('tool-')) toolRatings.push({ key: el.name.slice(5), rating: Number(el.value) });
  }
  btn.disabled = true; err.style.display = 'none';
  try {
    const res = await fetch(location.pathname, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: Number(rating.value), comment: f.comment.value, toolRatings }),
    });
    if (!res.ok) throw new Error();
    f.innerHTML = '<div class="brand">NORC</div><h1>Thank you! 🙏</h1><div class="sub">Your feedback was recorded. You can close this tab.</div>';
  } catch {
    btn.disabled = false; err.textContent = 'Something went wrong — please try again.'; err.style.display = 'block';
  }
});
</script>
</body></html>`;
}

function expiredPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Link expired — NORC</title>
<style>${SHELL_CSS}</style>
</head><body>
<div class="card">
  <div class="brand">NORC</div>
  <h1>This feedback link is gone</h1>
  <div class="sub">It was already used, or it expired — feedback links self-destruct after 7 days. Thanks anyway!</div>
</div>
</body></html>`;
}

export { router as feedbackPublicRouter };
