import os from 'node:os';
import path from 'node:path';

export interface WorkerConfig {
  /** Port the worker listens on. NORC dispatches here; its heartbeat GETs here. */
  port: number;
  /**
   * Shared secret required on every POST (the `X-Norc-Secret` header NORC sends).
   * Null when self-registering without one — the worker then generates it.
   */
  sharedSecret: string | null;
  /** The `claude` CLI binary (uses the machine's logged-in subscription). */
  claudeBin: string;
  /** Base directory for per-task working dirs (when no DEFAULT_CWD is set). */
  workDir: string;
  /** Fixed repo/working dir for every task. Null → a per-task dir under workDir. */
  defaultCwd: string | null;
  /** Optional model override (else Claude Code's default for the account). */
  model: string | null;
  /** Extra args appended to every `claude -p` invocation (advanced/escape hatch). */
  extraArgs: string[];
  /** Max Claude Code jobs running at once on this box. */
  maxConcurrency: number;
  /** Hard ceiling per job, after which the worker kills `claude` and reports failed. */
  jobTimeoutMs: number;
  /** Liveness heartbeat cadence to NORC while a job runs (keeps it off the timeout sweep). */
  heartbeatMs: number;
  /** Where the per-page session map is persisted (for --resume on feedback turns). */
  sessionsFile: string;

  // ── Self-registration (the zero-config copy-paste path) ──────────────────────
  /** NORC base URL. Set → the worker self-registers on first boot. */
  norcUrl: string | null;
  /** One-time registration token from NORC's invite prompt. */
  registerToken: string | null;
  /** Agent name override. Default: claude-<hostname>. */
  agentName: string | null;
  /** Override the URL NORC reaches the worker on. Default: auto-detect Tailscale. */
  publicUrl: string | null;
  /** Where {agentId, agentSecret, sharedSecret, url} is persisted after registration. */
  credentialsFile: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function strEnv(name: string): string | null {
  const v = (process.env[name] ?? '').trim();
  return v || null;
}

export function loadConfig(): WorkerConfig {
  const workDir = strEnv('WORK_DIR') ?? path.join(os.tmpdir(), 'norc-claude-worker');
  const extraRaw = strEnv('CLAUDE_EXTRA_ARGS');
  return {
    port: intEnv('PORT', 8080),
    sharedSecret: strEnv('NORC_SHARED_SECRET'),
    claudeBin: strEnv('CLAUDE_BIN') ?? 'claude',
    workDir,
    defaultCwd: strEnv('DEFAULT_CWD'),
    model: strEnv('CLAUDE_MODEL'),
    extraArgs: extraRaw ? extraRaw.split(/\s+/) : [],
    maxConcurrency: intEnv('MAX_CONCURRENCY', 2),
    jobTimeoutMs: intEnv('JOB_TIMEOUT_MS', 30 * 60_000),
    heartbeatMs: intEnv('HEARTBEAT_MS', 90_000),
    sessionsFile: strEnv('SESSIONS_FILE') ?? path.join(workDir, 'sessions.json'),
    norcUrl: strEnv('NORC_URL')?.replace(/\/+$/, '') ?? null,
    registerToken: strEnv('NORC_REGISTER_TOKEN'),
    agentName: strEnv('AGENT_NAME'),
    publicUrl: strEnv('WORKER_PUBLIC_URL')?.replace(/\/+$/, '') ?? null,
    credentialsFile: strEnv('CREDENTIALS_FILE') ?? path.join(workDir, 'credentials.json'),
  };
}
