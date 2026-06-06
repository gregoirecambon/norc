// Email-in-the-loop. When NORC's Triage Agent is unsure (suggests, asks, or has
// no agent to try), it pings a human by email in addition to writing in Notion.
// Transport is SMTP (configurable in Settings → Notifications); any provider works
// — a Gmail app password, your domain's SMTP, a transactional service, etc.
// Best-effort by design: a missing config or send failure logs and returns, never
// throwing into the Notion write path.

import nodemailer from 'nodemailer';
import { getNorcSettingsOrDefault } from './norc-settings.js';
import { emitLog } from './logger.js';

export interface Notification {
  subject: string;
  body: string;
  /** Optional deep link surfaced in the email footer. */
  url?: string;
}

export function notificationsConfigured(): boolean {
  const s = getNorcSettingsOrDefault();
  return !!(s.notifyEnabled && s.smtpHost && (s.notifyEmail || s.smtpUser));
}

/** Send a notification email. Never throws — returns false on any problem. */
export async function sendNotification(n: Notification): Promise<boolean> {
  const s = getNorcSettingsOrDefault();
  if (!s.notifyEnabled) return false;
  const to = s.notifyEmail ?? s.smtpUser;
  if (!s.smtpHost || !to) {
    emitLog('notify skipped: SMTP host or recipient not configured');
    return false;
  }
  const from = s.smtpFrom ?? s.smtpUser ?? to;
  const port = s.smtpPort ?? 587;
  try {
    const transport = nodemailer.createTransport({
      host: s.smtpHost,
      port,
      secure: port === 465, // implicit TLS on 465; STARTTLS otherwise
      ...(s.smtpUser ? { auth: { user: s.smtpUser, pass: s.smtpPass ?? '' } } : {}),
    });
    const text = n.url ? `${n.body}\n\n${n.url}` : n.body;
    await transport.sendMail({ from, to, subject: n.subject, text });
    emitLog(`notify: emailed "${n.subject}" → ${to}`);
    return true;
  } catch (err) {
    emitLog(`notify error: ${err instanceof Error ? err.message : 'send failed'}`);
    return false;
  }
}

/** Verify SMTP credentials without sending a real message. */
export async function testNotification(): Promise<{ ok: boolean; error?: string }> {
  const s = getNorcSettingsOrDefault();
  if (!s.smtpHost) return { ok: false, error: 'SMTP host not configured' };
  const port = s.smtpPort ?? 587;
  try {
    const transport = nodemailer.createTransport({
      host: s.smtpHost,
      port,
      secure: port === 465,
      ...(s.smtpUser ? { auth: { user: s.smtpUser, pass: s.smtpPass ?? '' } } : {}),
    });
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'verify failed' };
  }
}
