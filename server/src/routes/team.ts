import { Router, type Router as ExpressRouter } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { invites, users } from '../db/schema.js';
import { emitLog } from '../lib/logger.js';
import { zodMiddleware } from '../lib/validate.js';
import { isMailerConfigured, sendInviteEmail } from '../lib/mailer.js';
import { randomToken, requestUser, requireRole, sha256 } from '../lib/user-auth.js';

const router: ExpressRouter = Router();

const INVITE_TTL_MS = 7 * 24 * 3600_000;

function publicBase(): string {
  return (process.env['NORC_PUBLIC_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');
}

function inviteUrlFor(token: string): string {
  return `${publicBase()}/?invite=${token}`;
}

function memberView(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatarUrl: u.avatarUrl,
    role: u.role,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

function inviteView(i: typeof invites.$inferSelect) {
  // Never include the token (it's only stored hashed anyway) — links are
  // returned once, at create/resend time.
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    expired: i.expiresAt <= Date.now(),
  };
}

// GET /api/team — members for everyone; pending invites only for owner/admin.
router.get('/', (req, res) => {
  const members = db.select().from(users).all()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(memberView);
  const canManage = requestUser(req).role === 'owner' || requestUser(req).role === 'admin';
  const pending = canManage
    ? db.select().from(invites).all()
        .filter(i => !i.acceptedAt && !i.revokedAt)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(inviteView)
    : undefined;
  res.json({
    members,
    ...(pending ? { invites: pending } : {}),
    smtpConfigured: isMailerConfigured(),
  });
});

const InviteSchema = z.object({
  email: z.string().email().transform(e => e.toLowerCase().trim()),
  role: z.enum(['admin', 'member']).default('member'),
});

// POST /api/team/invites — owner/admin; admins may only invite members.
router.post('/invites', requireRole('owner', 'admin'), zodMiddleware(InviteSchema), async (req, res) => {
  const { email, role } = req.body as z.infer<typeof InviteSchema>;
  const inviter = requestUser(req);
  if (role === 'admin' && inviter.role !== 'owner') {
    res.status(403).json({ error: 'forbidden', message: 'Only the owner can invite admins.' });
    return;
  }
  if (db.select().from(users).where(eq(users.email, email)).all()[0]) {
    res.status(409).json({ error: 'already_member', message: `${email} is already a member.` });
    return;
  }
  const dupe = db.select().from(invites).where(eq(invites.email, email)).all()
    .find(i => !i.acceptedAt && !i.revokedAt && i.expiresAt > Date.now());
  if (dupe) {
    res.status(409).json({ error: 'already_invited', message: `${email} already has a pending invite.` });
    return;
  }

  const token = randomToken();
  const now = Date.now();
  const row = {
    id: randomUUID(),
    email,
    role,
    tokenHash: sha256(token),
    invitedBy: inviter.id,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
  };
  db.insert(invites).values(row).run();

  const url = inviteUrlFor(token);
  const mail = await sendInviteEmail(email, {
    inviteUrl: url,
    role,
    invitedByName: inviter.name ?? inviter.email,
  });
  emitLog(`invite ${mail.sent ? 'emailed' : 'created'} for ${email} (${role}) by ${inviter.email}`);
  res.status(201).json({
    invite: inviteView({ ...row, acceptedAt: null, revokedAt: null }),
    emailSent: mail.sent,
    ...(mail.error && mail.error !== 'smtp_not_configured' ? { emailError: mail.error } : {}),
    inviteUrl: url,
  });
});

// POST /api/team/invites/:id/resend — rotates the token and resets expiry.
router.post('/invites/:id/resend', requireRole('owner', 'admin'), async (req, res) => {
  const { id } = req.params as { id: string };
  const row = db.select().from(invites).where(eq(invites.id, id)).all()[0];
  if (!row || row.acceptedAt || row.revokedAt) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const token = randomToken();
  const expiresAt = Date.now() + INVITE_TTL_MS;
  db.update(invites).set({ tokenHash: sha256(token), expiresAt }).where(eq(invites.id, id)).run();

  const url = inviteUrlFor(token);
  const inviter = requestUser(req);
  const mail = await sendInviteEmail(row.email, {
    inviteUrl: url,
    role: row.role,
    invitedByName: inviter.name ?? inviter.email,
  });
  emitLog(`invite re-${mail.sent ? 'emailed' : 'issued'} for ${row.email} by ${inviter.email}`);
  res.json({
    invite: inviteView({ ...row, tokenHash: sha256(token), expiresAt }),
    emailSent: mail.sent,
    ...(mail.error && mail.error !== 'smtp_not_configured' ? { emailError: mail.error } : {}),
    inviteUrl: url,
  });
});

// DELETE /api/team/invites/:id — revoke a pending invite.
router.delete('/invites/:id', requireRole('owner', 'admin'), (req, res) => {
  const { id } = req.params as { id: string };
  const row = db.select().from(invites).where(eq(invites.id, id)).all()[0];
  if (!row || row.acceptedAt || row.revokedAt) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  db.update(invites).set({ revokedAt: Date.now() }).where(eq(invites.id, id)).run();
  emitLog(`invite revoked for ${row.email} by ${requestUser(req).email}`);
  res.json({ ok: true });
});

const RoleSchema = z.object({ role: z.enum(['admin', 'member']) });

// PATCH /api/team/members/:id — change a member's role. Owner only; the owner
// role itself is fixed (exactly one owner, never demotable).
router.patch('/members/:id', requireRole('owner'), zodMiddleware(RoleSchema), (req, res) => {
  const { id } = req.params as { id: string };
  const { role } = req.body as z.infer<typeof RoleSchema>;
  const target = db.select().from(users).where(eq(users.id, id)).all()[0];
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (target.role === 'owner') {
    res.status(403).json({ error: 'forbidden', message: 'The owner role cannot be changed.' });
    return;
  }
  db.update(users).set({ role }).where(eq(users.id, id)).run();
  emitLog(`${target.email} is now ${role} (changed by ${requestUser(req).email})`);
  res.json({ member: memberView({ ...target, role }) });
});

// DELETE /api/team/members/:id — owner can remove anyone but themself;
// admins can remove members only. Sessions cascade — removal = instant logout.
router.delete('/members/:id', requireRole('owner', 'admin'), (req, res) => {
  const { id } = req.params as { id: string };
  const actor = requestUser(req);
  const target = db.select().from(users).where(eq(users.id, id)).all()[0];
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (target.role === 'owner') {
    res.status(403).json({ error: 'forbidden', message: 'The owner cannot be removed.' });
    return;
  }
  if (target.id === actor.id) {
    res.status(403).json({ error: 'forbidden', message: 'You cannot remove yourself.' });
    return;
  }
  if (actor.role === 'admin' && target.role !== 'member') {
    res.status(403).json({ error: 'forbidden', message: 'Admins can only remove members.' });
    return;
  }
  db.delete(users).where(eq(users.id, id)).run();
  emitLog(`${target.email} removed from the team by ${actor.email}`);
  res.json({ ok: true });
});

export { router as teamRouter };
