// Auth for the /api/ext machine surface: one Bearer token, two principal
// kinds. An AI agent presents its agentSecret; an app presents its static
// 'norc_app_…' key. Both resolve to the same ExtPrincipal shape so every
// /api/ext route is principal-agnostic; scopes gate the mutating routes.
// Agents implicitly hold read + tasks:write (their /api/me surface already
// grants task intake); app scopes are chosen per key in the dashboard.

import type { NextFunction, Request, Response } from 'express';
import { getAgentFromBearer } from './auth.js';
import { findAppByKey, appScopes, logAppAccess, APP_KEY_PREFIX, type AppScope, type AppRow } from './apps.js';

export type ExtPrincipal =
  | { kind: 'agent'; id: string; name: string; scopes: AppScope[] }
  | { kind: 'app'; id: string; name: string; scopes: AppScope[]; app: AppRow };

const AGENT_SCOPES: AppScope[] = ['read', 'tasks:write'];

/** The principal attached by extAuthGuard. Only call on guarded routes. */
export function extPrincipal(req: Request): ExtPrincipal {
  return (req as Request & { extPrincipal: ExtPrincipal }).extPrincipal;
}

export function extAuthGuard(req: Request, res: Response, next: NextFunction): void {
  const auth = (req.headers['authorization'] ?? '').toString();
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: 'unauthorized', hint: 'Pass Authorization: Bearer <agentSecret or app key>' });
    return;
  }

  let principal: ExtPrincipal | null = null;
  if (token.startsWith(APP_KEY_PREFIX)) {
    const app = findAppByKey(token);
    if (app) {
      principal = { kind: 'app', id: app.id, name: app.name, scopes: appScopes(app), app };
      // Access trail — one row per request, stamped once the status is known.
      const { method } = req;
      const path = (req.originalUrl.split('?')[0] ?? '');
      res.on('finish', () => logAppAccess(app.id, method, path, res.statusCode, req.ip ?? null));
    }
  } else {
    const agent = getAgentFromBearer(req);
    if (agent) principal = { kind: 'agent', id: agent.id, name: agent.name, scopes: AGENT_SCOPES };
  }

  if (!principal) {
    res.status(401).json({ error: 'unauthorized', hint: 'Unknown, revoked, or malformed credential' });
    return;
  }
  (req as Request & { extPrincipal: ExtPrincipal }).extPrincipal = principal;
  next();
}

/** Per-route scope gate. Use after extAuthGuard populated the principal. */
export function requireScope(scope: AppScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!extPrincipal(req).scopes.includes(scope)) {
      res.status(403).json({ error: 'forbidden', hint: `This credential lacks the '${scope}' scope` });
      return;
    }
    next();
  };
}
