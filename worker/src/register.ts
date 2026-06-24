import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { WorkerConfig } from './config.js';
import { log } from './log.js';

export interface Credentials {
  agentId: string;
  agentSecret: string;
  sharedSecret: string;
  url: string;
  name: string;
}

export function loadCredentials(file: string): Credentials | null {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as Credentials;
    return c.sharedSecret ? c : null;
  } catch {
    return null;
  }
}

function saveCredentials(file: string, creds: Credentials): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(creds, null, 2));
}

/** This machine's Tailscale URL, so a NORC on the same tailnet can reach the worker. */
export function detectWorkerUrl(config: WorkerConfig): string {
  if (config.publicUrl) return config.publicUrl;
  // Prefer the Tailscale IP — stable per node and reachable across the tailnet
  // regardless of NAT/firewall.
  try {
    const out = execFileSync('tailscale', ['ip', '-4'], { timeout: 5000 }).toString();
    const ip = out.split(/\s+/).map(s => s.trim()).find(s => /^100\./.test(s));
    if (ip) return `http://${ip}:${config.port}/`;
  } catch {
    // tailscale not installed / not up — fall through to hostname.
  }
  return `http://${os.hostname()}:${config.port}/`;
}

/** claude-<hostname>, sanitized to NORC's agent-name rule. */
function defaultName(): string {
  const host = os.hostname().toLowerCase().split('.')[0] ?? 'agent';
  const slug = host.replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'agent';
  return `claude-${slug}`;
}

async function postRegister(
  norcUrl: string,
  token: string,
  body: { name: string; adapterType: string; adapterConfig: Record<string, unknown>; metadata: Record<string, unknown> },
): Promise<{ ok: true; agentId: string; agentSecret: string } | { ok: false; status: number; error: string }> {
  const res = await fetch(`${norcUrl}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    return { ok: false, status: res.status, error: typeof json['error'] === 'string' ? json['error'] : `HTTP ${res.status}` };
  }
  return { ok: true, agentId: String(json['agentId'] ?? ''), agentSecret: String(json['agentSecret'] ?? '') };
}

/**
 * Resolve the worker's identity. If creds already exist (a prior boot), reuse them —
 * the registration token is single-use, so a restart must NOT re-register. Otherwise,
 * if NORC_URL + token are present, self-register over Tailscale and persist creds.
 * Returns the shared secret the HTTP server must enforce, or throws with guidance.
 */
export async function resolveIdentity(config: WorkerConfig): Promise<{ sharedSecret: string; selfRegistered: boolean }> {
  const existing = loadCredentials(config.credentialsFile);
  if (existing) {
    log(`reusing registered identity "${existing.name}" (${config.credentialsFile})`);
    return { sharedSecret: existing.sharedSecret, selfRegistered: false };
  }

  const canSelfRegister = !!(config.norcUrl && config.registerToken);
  if (!canSelfRegister) {
    if (config.sharedSecret) return { sharedSecret: config.sharedSecret, selfRegistered: false };
    throw new Error(
      'No identity configured. Either set NORC_URL + NORC_REGISTER_TOKEN to self-register '
      + '(the copy-paste path), or set NORC_SHARED_SECRET and register the agent manually in '
      + 'the NORC dashboard.',
    );
  }

  const sharedSecret = config.sharedSecret ?? randomBytes(32).toString('hex');
  const url = detectWorkerUrl(config);
  let name = config.agentName ?? defaultName();

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await postRegister(config.norcUrl!, config.registerToken!, {
      name,
      adapterType: 'http',
      // workDir/defaultCwd let NORC reconstruct the per-task cwd for the dashboard's
      // "resume" helper (cd <cwd> && claude --resume <id>). Not secrets.
      adapterConfig: {
        url,
        sharedSecret,
        workDir: config.workDir,
        ...(config.defaultCwd ? { defaultCwd: config.defaultCwd } : {}),
      },
      metadata: { kind: 'remote-claude-code', host: os.hostname() },
    });
    if (result.ok) {
      const creds: Credentials = { agentId: result.agentId, agentSecret: result.agentSecret, sharedSecret, url, name };
      saveCredentials(config.credentialsFile, creds);
      log(`registered with NORC as "${name}" → ${url}`);
      return { sharedSecret, selfRegistered: true };
    }
    if (result.error === 'name_taken') {
      name = `${defaultName()}-${randomBytes(2).toString('hex')}`;
      continue;
    }
    throw new Error(`registration failed: ${result.error}. Get a fresh invite from the NORC dashboard.`);
  }
  throw new Error('registration failed: could not find a free agent name after 3 tries.');
}
