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

      // Parse NORC_OUTPUT sentinel line — must be the last non-empty line
      let nextAgent: string | undefined;
      let parsedSummary: string | undefined;
      const lines = stdout.trimEnd().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('NORC_OUTPUT:')) {
          try {
            const json = JSON.parse(line.slice('NORC_OUTPUT:'.length).trim());
            if (json.next_agent) nextAgent = json.next_agent;
            if (json.summary) parsedSummary = json.summary;
          } catch {
            // Malformed sentinel — ignore, fall through to default summary
          }
          break;
        }
      }

      resolve({
        success: code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        summary: parsedSummary ?? (stdout.slice(0, 300) || stderr.slice(0, 300) || 'No output'),
        nextAgent,
      });
    });
  });
}
