import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** One Claude Code session, keyed by the Notion page/task id NORC dispatched. */
export interface SessionRecord {
  sessionId: string;
  cwd: string;
  updatedAt: number;
}

/**
 * Tiny JSON-file store mapping a Notion page id → its Claude Code session. When NORC
 * re-dispatches the same task (a feedback/follow-up turn), the worker resumes that
 * session (`claude --resume <id>`) so Claude continues with full prior context.
 */
export class SessionStore {
  private data: Record<string, SessionRecord> = {};

  constructor(private file: string) {
    try {
      this.data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, SessionRecord>;
    } catch {
      this.data = {};
    }
  }

  get(pageId: string): SessionRecord | undefined {
    return this.data[pageId];
  }

  set(pageId: string, rec: SessionRecord): void {
    this.data[pageId] = rec;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {
      // Best-effort: a lost session map just means the next turn starts fresh.
    }
  }
}
