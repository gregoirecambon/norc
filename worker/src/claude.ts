import { spawn } from 'node:child_process';
import { log } from './log.js';

export interface ClaudeResult {
  ok: boolean;
  text: string;
  /** The Claude Code session id, captured so a later turn can --resume it. */
  sessionId: string | null;
  error?: string;
}

export interface RunClaudeArgs {
  claudeBin: string;
  prompt: string;
  cwd: string;
  model: string | null;
  appendSystemPrompt: string | null;
  resumeSessionId: string | null;
  extraArgs: string[];
  timeoutMs: number;
}

/**
 * Run Claude Code headlessly via `claude -p`, fully autonomous
 * (--dangerously-skip-permissions), using the machine's logged-in subscription.
 * The prompt is fed on stdin so long prompts don't hit argv limits. On a feedback
 * turn we pass --resume so Claude continues the same session.
 */
export function runClaude(args: RunClaudeArgs): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const cli: string[] = ['-p', '--output-format', 'json', '--dangerously-skip-permissions'];
    if (args.model) cli.push('--model', args.model);
    if (args.appendSystemPrompt) cli.push('--append-system-prompt', args.appendSystemPrompt);
    if (args.resumeSessionId) cli.push('--resume', args.resumeSessionId);
    cli.push(...args.extraArgs);

    log(`spawn ${args.claudeBin} -p (cwd=${args.cwd}${args.resumeSessionId ? `, resume=${args.resumeSessionId}` : ', new session'})`);

    const child = spawn(args.claudeBin, cli, {
      cwd: args.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: ClaudeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, text: '', sessionId: null, error: `Claude Code timed out after ${Math.round(args.timeoutMs / 1000)}s` });
    }, args.timeoutMs);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => finish({
      ok: false, text: '', sessionId: null,
      error: `failed to spawn ${args.claudeBin}: ${err.message}`,
    }));
    child.on('close', (code) => {
      const parsed = parseClaudeJson(stdout);
      if (parsed) {
        finish({
          ok: !parsed.isError && code === 0,
          text: parsed.text,
          sessionId: parsed.sessionId,
          ...(parsed.isError ? { error: parsed.text || 'Claude reported an error' } : {}),
        });
        return;
      }
      // JSON parse failed — fall back to raw stdout / stderr.
      const text = stdout.trim();
      if (code === 0 && text) { finish({ ok: true, text, sessionId: null }); return; }
      finish({
        ok: false, text, sessionId: null,
        error: (stderr.trim().split('\n')[0]) || `claude exited with code ${code}`,
      });
    });

    child.stdin.write(args.prompt);
    child.stdin.end();
  });
}

interface ParsedClaude {
  text: string;
  sessionId: string | null;
  isError: boolean;
}

/** Parse the single JSON object `claude -p --output-format json` prints. */
function parseClaudeJson(stdout: string): ParsedClaude | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Be lenient if a stray line slipped in: take the last JSON object.
    const start = trimmed.lastIndexOf('{');
    if (start >= 0) {
      try { obj = JSON.parse(trimmed.slice(start)) as Record<string, unknown>; } catch { obj = null; }
    }
  }
  if (!obj) return null;
  const text = typeof obj['result'] === 'string' ? obj['result']
    : typeof obj['text'] === 'string' ? obj['text'] : '';
  const sessionId = typeof obj['session_id'] === 'string' ? obj['session_id']
    : typeof obj['sessionId'] === 'string' ? obj['sessionId'] : null;
  const isError = obj['is_error'] === true
    || obj['subtype'] === 'error_during_execution'
    || obj['subtype'] === 'error_max_turns';
  return { text, sessionId, isError };
}
