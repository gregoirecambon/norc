import { Router, type Router as ExpressRouter } from 'express';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { invites, users } from '../db/schema.js';
import { emitLog } from '../lib/logger.js';
import {
  enabledProviders, isProvider, authorizeUrl, exchangeAndFetchIdentity,
} from '../lib/oauth.js';
import {
  randomToken, sha256, createSession, destroySession, getSessionUser,
  setSessionCookie, clearSessionCookie,
  setOauthStateCookie, clearOauthStateCookie, OAUTH_STATE_COOKIE, parseCookies,
} from '../lib/user-auth.js';

const router: ExpressRouter = Router();

// GET /api/auth/providers — which sign-in buttons to render.
router.get('/providers', (_req, res) => {
  // publicUrl lets the UI detect it's being browsed from a non-canonical
  // origin (e.g. localhost while NORC_PUBLIC_URL is a tunnel) — OAuth state
  // cookies only survive the round-trip on the canonical origin.
  res.json({
    ...enabledProviders(),
    publicUrl: (process.env['NORC_PUBLIC_URL'] ?? '').replace(/\/+$/, '') || null,
  });
});

// GET /api/auth/session — the UI's gate. Always 200; user is null when signed out.
router.get('/session', (req, res) => {
  const user = getSessionUser(req);
  res.json({
    user: user
      ? { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, role: user.role }
      : null,
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  destroySession(req);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/invite/:token — public invite preview for the login page banner.
router.get('/invite/:token', (req, res) => {
  const { token } = req.params as { token: string };
  const row = db.select().from(invites).where(eq(invites.tokenHash, sha256(token))).all()[0];
  const valid = !!row && !row.acceptedAt && !row.revokedAt && row.expiresAt > Date.now();
  if (!valid) {
    res.json({ valid: false });
    return;
  }
  res.json({ valid: true, email: row.email, role: row.role, expiresAt: row.expiresAt });
});

// GET /api/auth/:provider/start?invite=<token> — full-page redirect to the provider.
router.get('/:provider/start', (req, res) => {
  const provider = (req.params as { provider: string }).provider;
  if (!isProvider(provider) || !enabledProviders()[provider]) {
    res.status(404).json({ error: 'provider_not_configured' });
    return;
  }
  const state = randomToken();
  const invite = typeof req.query['invite'] === 'string' ? req.query['invite'] : '';
  // The state cookie carries the invite token along the round-trip (state.invite).
  setOauthStateCookie(res, invite ? `${state}.${invite}` : state);
  res.redirect(authorizeUrl(provider, state));
});

// GET /api/auth/:provider/callback?code&state — the provider redirects back here.
router.get('/:provider/callback', async (req, res) => {
  const provider = (req.params as { provider: string }).provider;
  const fail = (reason: string) => res.redirect(`/?auth_error=${encodeURIComponent(reason)}`);
  if (!isProvider(provider) || !enabledProviders()[provider]) {
    fail('oauth_failed');
    return;
  }

  // Provider-reported errors (e.g. access_denied when the user isn't a test
  // user of an in-testing Google app) arrive as ?error= with no code.
  const providerError = typeof req.query['error'] === 'string' ? req.query['error'] : '';
  if (providerError) {
    emitLog(`oauth ${provider} sign-in rejected by provider: ${providerError}`);
    fail(providerError === 'access_denied' ? 'access_denied' : 'oauth_failed');
    return;
  }

  // CSRF check: state must match the value we set before redirecting out.
  const stateCookie = parseCookies(req)[OAUTH_STATE_COOKIE] ?? '';
  clearOauthStateCookie(res);
  const dot = stateCookie.indexOf('.');
  const expectedState = dot < 0 ? stateCookie : stateCookie.slice(0, dot);
  const inviteToken = dot < 0 ? '' : stateCookie.slice(dot + 1);
  const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
  const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
  if (!expectedState || state !== expectedState) {
    // Typical cause: sign-in started on a different origin than NORC_PUBLIC_URL
    // (the state cookie lives on the origin that served /start).
    emitLog(`oauth ${provider} sign-in failed: state cookie ${expectedState ? 'mismatch' : 'missing'}`);
    fail('state_mismatch');
    return;
  }
  if (!code) {
    emitLog(`oauth ${provider} sign-in failed: no authorization code in callback`);
    fail('oauth_failed');
    return;
  }

  let identity;
  try {
    identity = await exchangeAndFetchIdentity(provider, code);
  } catch (err) {
    emitLog(`oauth ${provider} sign-in failed: ${err instanceof Error ? err.message : 'unknown'}`);
    fail('oauth_failed');
    return;
  }

  // Resolve the identity to a user inside a transaction (first-boot owner
  // creation and invite acceptance must be atomic).
  const now = Date.now();
  const result = db.transaction(tx => {
    const existing = tx.select().from(users).where(eq(users.email, identity.email)).all()[0];
    if (existing) {
      tx.update(users).set({
        name: identity.name ?? existing.name,
        avatarUrl: identity.avatarUrl ?? existing.avatarUrl,
        provider,
        providerSubject: identity.subject,
        lastLoginAt: now,
      }).where(eq(users.id, existing.id)).run();
      return { userId: existing.id, created: false as const };
    }

    // First user on an empty table becomes the owner.
    const anyUser = tx.select({ id: users.id }).from(users).limit(1).all()[0];
    let role: string | null = anyUser ? null : 'owner';
    let inviteId: string | null = null;

    if (!role) {
      // Otherwise an invite must match: by link token if present, else by email.
      const candidate = inviteToken
        ? tx.select().from(invites).where(eq(invites.tokenHash, sha256(inviteToken))).all()[0]
        : tx.select().from(invites).where(eq(invites.email, identity.email)).all()
            .filter(i => !i.acceptedAt && !i.revokedAt && i.expiresAt > now)[0];
      const usable = candidate && !candidate.acceptedAt && !candidate.revokedAt
        && candidate.expiresAt > now && candidate.email === identity.email;
      if (!usable || !candidate) return { userId: null, created: false as const };
      role = candidate.role;
      inviteId = candidate.id;
    }

    const userId = randomUUID();
    tx.insert(users).values({
      id: userId,
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
      role,
      provider,
      providerSubject: identity.subject,
      createdAt: now,
      lastLoginAt: now,
    }).run();
    if (inviteId) tx.update(invites).set({ acceptedAt: now }).where(eq(invites.id, inviteId)).run();
    return { userId, created: true as const, role };
  });

  if (!result.userId) {
    res.redirect(`/?auth_error=not_invited&email=${encodeURIComponent(identity.email)}`);
    return;
  }

  if (result.created) {
    emitLog(`new ${result.role} signed in: ${identity.email} (via ${provider})`);
  }
  const { token } = createSession(result.userId, req.headers['user-agent']?.toString());
  setSessionCookie(res, token);
  res.redirect('/');
});

export { router as authRouter };
