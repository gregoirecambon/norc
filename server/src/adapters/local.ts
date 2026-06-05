import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PingResult } from '../types.js';
import type { DispatchResult } from './index.js';

const execFileAsync = promisify(execFile);

/**
 * Dispatch an agent turn to a local CLI (e.g. `claude -p "<prompt>"`), capturing
 * stdout. Synchronous from the orchestrator's view (it awaits process exit);
 * the async + callback path for long runs arrives in Phase 3.
 */
export async function dispatchLocalCli(
  config: Record<string, unknown>,
  system: string,
  prompt: string,
  defaultCommand: string,
): Promise<DispatchResult> {
  const command = typeof config['command'] === 'string' && config['command'] ? config['command'] : defaultCommand;
  const cwd = typeof config['cwd'] === 'string' && config['cwd'] ? config['cwd'] : undefined;
  const promptFlag = typeof config['promptFlag'] === 'string' && config['promptFlag'] ? config['promptFlag'] : '-p';
  const timeoutMs = typeof config['timeoutMs'] === 'number' ? config['timeoutMs'] : 180_000;
  const full = system ? `${system}\n\n${prompt}` : prompt;

  try {
    const { stdout } = await execFileAsync(command, [promptFlag, full], {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, supported: true, text: stdout.trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, supported: true, error: msg.split('\n')[0] };
  }
}

export async function pingLocalCli(
  config: Record<string, unknown>,
  start: number,
  defaultCommand: string,
): Promise<PingResult> {
  const command = typeof config['command'] === 'string' && config['command'] ? config['command'] : defaultCommand;
  const cwd = typeof config['cwd'] === 'string' && config['cwd'] ? config['cwd'] : undefined;

  try {
    await execFileAsync(command, ['--version'], {
      cwd,
      timeout: 5000,
      env: { ...process.env },
    });
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, latencyMs: Date.now() - start, error: `${command} not available: ${msg.split('\n')[0]}` };
  }
}
