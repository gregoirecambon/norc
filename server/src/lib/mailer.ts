import nodemailer from 'nodemailer';
import { getNorcSettingsOrDefault } from './norc-settings.js';

// Invite emails over plain SMTP (works with any provider). Config lives in
// NORC settings (editable from Settings → Email); SMTP_* env vars are the
// fallback for env-only installs. Entirely optional: when nothing is
// configured — or a send fails — callers fall back to showing a copyable
// invite link in the UI, so invites always work.

export interface SmtpConfig {
  host: string;
  port: number;
  user: string | null;
  pass: string | null;
  from: string | null;
  secure: boolean;
}

function envConfig(): SmtpConfig | null {
  const host = (process.env['SMTP_HOST'] ?? '').trim();
  if (!host) return null;
  return {
    host,
    port: parseInt(process.env['SMTP_PORT'] ?? '587', 10),
    user: (process.env['SMTP_USER'] ?? '').trim() || null,
    pass: process.env['SMTP_PASS'] || null,
    from: (process.env['SMTP_FROM'] ?? '').trim() || null,
    secure: (process.env['SMTP_SECURE'] ?? '') === 'true' || process.env['SMTP_PORT'] === '465',
  };
}

/** Effective SMTP config: DB settings win, env vars are the fallback. */
export function resolveSmtpConfig(): SmtpConfig | null {
  const s = getNorcSettingsOrDefault();
  if (s.smtpHost?.trim()) {
    return {
      host: s.smtpHost.trim(),
      port: s.smtpPort ?? 587,
      user: s.smtpUser,
      pass: s.smtpPass,
      from: s.smtpFrom,
      secure: s.smtpSecure,
    };
  }
  return envConfig();
}

export function isMailerConfigured(): boolean {
  return resolveSmtpConfig() !== null;
}

/** Where the active config comes from — shown in Settings → Email. */
export function smtpSource(): 'settings' | 'env' | null {
  if (getNorcSettingsOrDefault().smtpHost?.trim()) return 'settings';
  return envConfig() ? 'env' : null;
}

interface MailContent { to: string; subject: string; text: string; html: string }

/** Send via the given config. Never throws — returns { sent, error? }. */
async function send(cfg: SmtpConfig, mail: MailContent): Promise<{ sent: boolean; error?: string }> {
  try {
    // Transports are cheap to build and sends are rare (invites, tests) — no
    // caching, so settings changes always apply immediately.
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure || cfg.port === 465,
      ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass ?? '' } } : {}),
    });
    const from = cfg.from ?? cfg.user ?? '';
    await transport.sendMail({ ...(from ? { from: `NORC <${from}>` } : {}), ...mail });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : 'send_failed' };
  }
}

export interface InviteEmailParams {
  inviteUrl: string;
  role: string;
  invitedByName: string;
}

/** Send an invite email. Never throws — returns { sent, error? }. */
export async function sendInviteEmail(
  to: string,
  { inviteUrl, role, invitedByName }: InviteEmailParams,
): Promise<{ sent: boolean; error?: string }> {
  const cfg = resolveSmtpConfig();
  if (!cfg) return { sent: false, error: 'smtp_not_configured' };
  return send(cfg, {
    to,
    subject: `${invitedByName} invited you to NORC`,
    text: `${invitedByName} invited you to join their NORC workspace as ${role}.\n\nAccept the invite:\n${inviteUrl}\n\nThis link expires in 7 days.`,
    html: `
<div style="font-family:-apple-system,Segoe UI,Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#37352f">
  <div style="font-size:20px;font-weight:700;letter-spacing:-0.3px;margin-bottom:20px">NORC</div>
  <p style="font-size:15px;line-height:1.6">
    <strong>${invitedByName}</strong> invited you to join their NORC workspace as <strong>${role}</strong>.
  </p>
  <p style="margin:28px 0">
    <a href="${inviteUrl}" style="background:#5645d4;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:14px;font-weight:600">Accept invite</a>
  </p>
  <p style="font-size:13px;color:#787671;line-height:1.6">
    Or paste this link in your browser:<br>
    <a href="${inviteUrl}" style="color:#5645d4;word-break:break-all">${inviteUrl}</a>
  </p>
  <p style="font-size:12px;color:#787671">This link expires in 7 days.</p>
</div>`,
  });
}

/**
 * Send a test email — used by Settings → Email. `override` carries unsaved
 * form values; omitted fields fall back to the effective config.
 */
export async function sendTestEmail(
  to: string,
  override?: Partial<SmtpConfig>,
): Promise<{ sent: boolean; error?: string }> {
  const base = resolveSmtpConfig();
  const host = override?.host?.trim() || base?.host;
  if (!host) return { sent: false, error: 'smtp_not_configured' };
  const cfg: SmtpConfig = {
    host,
    port: override?.port ?? base?.port ?? 587,
    user: override?.user !== undefined ? override.user : base?.user ?? null,
    pass: override?.pass !== undefined ? override.pass : base?.pass ?? null,
    from: override?.from !== undefined ? override.from : base?.from ?? null,
    secure: override?.secure ?? base?.secure ?? false,
  };
  return send(cfg, {
    to,
    subject: 'NORC test email',
    text: 'Your NORC email setup works. Team invites will be delivered from this address.',
    html: `
<div style="font-family:-apple-system,Segoe UI,Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#37352f">
  <div style="font-size:20px;font-weight:700;letter-spacing:-0.3px;margin-bottom:20px">NORC</div>
  <p style="font-size:15px;line-height:1.6">✅ Your NORC email setup works.</p>
  <p style="font-size:13px;color:#787671;line-height:1.6">Team invites will be delivered from this address.</p>
</div>`,
  });
}
