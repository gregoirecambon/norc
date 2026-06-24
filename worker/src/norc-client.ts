import { log } from './log.js';

/**
 * Thin client over NORC's token-scoped Agent API. `apiBase` is the full
 * `https://<norc>/api/runs/<run-token>` URL the worker parses out of the dispatch
 * prompt's `[NORC RUN]` block. The token authenticates the run and routes writes to
 * the right Notion page; it's valid only while the run is in-flight.
 */
export class NorcRun {
  constructor(private apiBase: string) {}

  private async post(endpoint: string, body: unknown): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiBase}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        log(`callback ${endpoint} -> HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      log(`callback ${endpoint} failed: ${err instanceof Error ? err.message : 'unknown'}`);
      return false;
    }
  }

  /**
   * Liveness ping. POST /status with an empty body does no Notion write but the
   * Agent API middleware bumps the run's progress clock, keeping a long job off
   * NORC's idle-timeout sweep without spamming the task with comments.
   */
  heartbeat(): Promise<boolean> {
    return this.post('status', {});
  }

  comment(text: string): Promise<boolean> {
    return this.post('comment', { text });
  }

  status(body: { status?: string; agentOutput?: string }): Promise<boolean> {
    return this.post('status', body);
  }

  artifact(body: { filename: string; contentBase64: string; mimeType?: string; caption?: string }): Promise<boolean> {
    return this.post('artifact', body);
  }

  /** Terminal report. NORC posts a visible comment, drives task status, releases dependents.
   * `sessionId` is the Claude Code session id so the dashboard shows a resumable id. */
  complete(body: { status?: string; summary?: string; sessionId?: string }): Promise<boolean> {
    return this.post('complete', body);
  }
}
