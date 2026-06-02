import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { AgentInput, AgentOutput } from '../types/index.js';

export async function executeClaudeCode(input: AgentInput): Promise<AgentOutput> {
  const workDir = process.env.NORC_WORK_DIR ?? process.cwd();

  // Write prompt to a temp file to avoid shell argument length limits
  const promptFile = join(tmpdir(), `norc-prompt-${randomBytes(8).toString('hex')}.txt`);
  await writeFile(promptFile, input.systemPrompt, 'utf-8');

  return new Promise<AgentOutput>((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn(
      'claude',
      ['--print', '--input-file', promptFile],
      {
        cwd: workDir,
        env: {
          ...process.env,
          ...input.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timeoutHandle = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        success: false,
        exitCode: -1,
        stdout,
        stderr: 'Timeout exceeded',
        summary: 'Agent timed out',
      });
    }, input.timeoutMs);

    child.on('close', async (code) => {
      clearTimeout(timeoutHandle);
      await unlink(promptFile).catch(() => {});

      resolve({
        success: code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        summary: stdout.slice(0, 300) || stderr.slice(0, 300) || 'No output',
      });
    });
  });
}
