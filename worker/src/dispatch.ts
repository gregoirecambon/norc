import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { WorkerConfig } from './config.js';
import { SessionStore } from './sessions.js';
import { NorcRun } from './norc-client.js';
import { runClaude } from './claude.js';
import { log } from './log.js';

export interface DispatchPayload {
  type: string;
  system?: string;
  prompt?: string;
}

/** Pull a `field: value` line out of the dispatch prompt's [NORC RUN] block. */
function parseField(prompt: string, field: string): string | null {
  const m = prompt.match(new RegExp(`${field}:\\s*(\\S+)`));
  return m ? m[1]! : null;
}

export class Dispatcher {
  private store: SessionStore;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private config: WorkerConfig) {
    this.store = new SessionStore(config.sessionsFile);
  }

  /** Accept a dispatch and run it in the background. Returns immediately. */
  accept(payload: DispatchPayload): void {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const system = typeof payload.system === 'string' ? payload.system : '';
    const apiBase = parseField(prompt, 'api_base');
    const pageId = parseField(prompt, 'notion_page_id');
    if (!apiBase) {
      log('dispatch missing api_base in prompt — cannot report back, ignoring');
      return;
    }
    void this.runJob({ apiBase, pageId, system, prompt });
  }

  private acquire(): Promise<void> {
    if (this.active < this.config.maxConcurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(() => { this.active++; resolve(); }));
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  private async runJob(job: {
    apiBase: string;
    pageId: string | null;
    system: string;
    prompt: string;
  }): Promise<void> {
    await this.acquire();
    const run = new NorcRun(job.apiBase);
    const heartbeat = setInterval(() => { void run.heartbeat(); }, this.config.heartbeatMs);
    try {
      const prior = job.pageId ? this.store.get(job.pageId) : undefined;
      const cwd = prior?.cwd ?? this.resolveCwd(job.pageId);
      mkdirSync(cwd, { recursive: true });

      const result = await runClaude({
        claudeBin: this.config.claudeBin,
        prompt: job.prompt,
        cwd,
        model: this.config.model,
        appendSystemPrompt: job.system || null,
        resumeSessionId: prior?.sessionId ?? null,
        extraArgs: this.config.extraArgs,
        timeoutMs: this.config.jobTimeoutMs,
      });

      // Remember the session so a later feedback turn on this page resumes it.
      if (result.sessionId && job.pageId) {
        this.store.set(job.pageId, { sessionId: result.sessionId, cwd, updatedAt: Date.now() });
      }

      if (result.ok) {
        const summary = result.text.trim() || '(Claude Code finished but returned no text.)';
        await run.complete({ status: 'done', summary });
        log(`job done (page ${job.pageId ?? '?'}) — ${summary.length} chars`);
      } else {
        await run.complete({ status: 'failed', summary: result.error || 'Claude Code failed.' });
        log(`job failed (page ${job.pageId ?? '?'}): ${result.error ?? 'unknown'}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      await run.complete({ status: 'failed', summary: `Worker error: ${msg}` });
      log(`job error: ${msg}`);
    } finally {
      clearInterval(heartbeat);
      this.release();
    }
  }

  private resolveCwd(pageId: string | null): string {
    if (this.config.defaultCwd) return this.config.defaultCwd;
    return path.join(this.config.workDir, pageId ?? `run-${Date.now()}`);
  }
}
