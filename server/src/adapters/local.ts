import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PingResult } from '../types.js';

const execFileAsync = promisify(execFile);

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
