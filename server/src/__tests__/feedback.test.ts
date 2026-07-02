import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations, db } from '../db/client.js';
import { agents, feedbackInvites, norcSettings, taskRuns } from '../db/schema.js';
import { createRun, finalizeRun } from '../lib/runs.js';
import { RunTool, questionsForFlags } from '../lib/run-tools.js';
import { upsertNorcSettings } from '../lib/norc-settings.js';
import { maybeInviteForRun, pruneExpiredFeedbackInvites, sendInvite, INVITE_TTL_MS } from '../lib/feedback.js';

function addAgent(id = 'a1', name = 'alpha') {
  db.insert(agents).values({
    id, name, adapterType: 'openclaw', adapterConfig: '{}', status: 'untested',
    registeredAt: Date.now(), metadata: '{}', maxConcurrentRuns: 1,
  }).run();
}

function finishedWorkRun(lane: 'work' | 'chat' = 'work'): string {
  const { id } = createRun({ agentId: 'a1', pageId: 'p1', taskPageId: 'p1', anchorKind: 'task', manageTaskStatus: true, lane, title: 'Ship the thing' });
  finalizeRun(id, 'done');
  return id;
}

beforeAll(() => { runMigrations(); });
beforeEach(() => {
  db.delete(feedbackInvites).run();
  db.delete(taskRuns).run();
  db.delete(agents).run();
  db.delete(norcSettings).run();
  addAgent();
});

describe('questionsForFlags', () => {
  it('returns nothing for a run that used no tools', () => {
    expect(questionsForFlags(0)).toEqual([]);
  });

  it('returns one question per used tool', () => {
    const qs = questionsForFlags(RunTool.SLACK | RunTool.TRIAGE);
    expect(qs.map(q => q.key).sort()).toEqual(['slack', 'triage']);
    for (const q of qs) expect(q.label.length).toBeGreaterThan(10);
  });

  it('caps at 3 questions, in priority order', () => {
    const all = RunTool.SLACK | RunTool.PROPOSE_TASKS | RunTool.REMOTE_WORKER | RunTool.TRIAGE;
    const qs = questionsForFlags(all);
    expect(qs).toHaveLength(3);
    expect(qs.map(q => q.key)).toEqual(['triage', 'remote_worker', 'propose_tasks']);
  });
});

describe('maybeInviteForRun', () => {
  it('does nothing while feedback is disabled', async () => {
    const runId = finishedWorkRun();
    expect(await maybeInviteForRun(runId, { force: true })).toBeNull();
    expect(db.select().from(feedbackInvites).all()).toHaveLength(0);
  });

  it('skips chat-lane runs even when enabled', async () => {
    upsertNorcSettings({ feedbackEnabled: true, feedbackSampleRate: 1 });
    const runId = finishedWorkRun('chat');
    expect(await maybeInviteForRun(runId, { force: true })).toBeNull();
  });

  it('mints a 7-day invite with the run snapshot and tool questions', async () => {
    upsertNorcSettings({ feedbackEnabled: true, feedbackSampleRate: 1 });
    const runId = finishedWorkRun();
    const before = Date.now();
    const invite = await maybeInviteForRun(runId, { force: true });
    expect(invite).not.toBeNull();
    expect(invite!.runId).toBe(runId);
    expect(invite!.runTitle).toBe('Ship the thing');
    expect(invite!.agentName).toBe('alpha');
    expect(invite!.token).toMatch(/^[0-9a-f]{48}$/);
    expect(invite!.expiresAt).toBeGreaterThanOrEqual(before + INVITE_TTL_MS);
    // No Slack/SMTP configured in tests → unresolved recipient, unsent.
    expect(invite!.recipient).toBeNull();
    expect(invite!.sentAt).toBeNull();
    // The openclaw agent → remote_worker question snapshotted.
    const questions = JSON.parse(invite!.questionsJson) as { key: string }[];
    expect(questions.map(q => q.key)).toContain('remote_worker');
  });

  it('never mints twice for the same run', async () => {
    upsertNorcSettings({ feedbackEnabled: true, feedbackSampleRate: 1 });
    const runId = finishedWorkRun();
    expect(await maybeInviteForRun(runId, { force: true })).not.toBeNull();
    expect(await maybeInviteForRun(runId, { force: true })).toBeNull();
    expect(db.select().from(feedbackInvites).all()).toHaveLength(1);
  });

  it('loses the sampling draw when the rate is 0', async () => {
    upsertNorcSettings({ feedbackEnabled: true, feedbackSampleRate: 0 });
    const runId = finishedWorkRun();
    expect(await maybeInviteForRun(runId)).toBeNull();
  });
});

describe('sendInvite', () => {
  it('reports no_recipient for a copy-link-only invite without touching sentAt', async () => {
    upsertNorcSettings({ feedbackEnabled: true, feedbackSampleRate: 1 });
    const invite = (await maybeInviteForRun(finishedWorkRun(), { force: true }))!;
    const result = await sendInvite(invite);
    expect(result).toEqual({ sent: false, error: 'no_recipient' });
    const row = db.select().from(feedbackInvites).where(eq(feedbackInvites.id, invite.id)).all()[0]!;
    expect(row.sentAt).toBeNull();
  });
});

describe('pruneExpiredFeedbackInvites', () => {
  it('deletes only invites past their expiry', async () => {
    upsertNorcSettings({ feedbackEnabled: true, feedbackSampleRate: 1 });
    const live = (await maybeInviteForRun(finishedWorkRun(), { force: true }))!;
    const dead = db.insert(feedbackInvites).values({
      id: 'dead', runId: 'r-old', token: 'f'.repeat(48), channel: 'email',
      recipient: null, recipientName: null, runTitle: null, agentId: null, agentName: null,
      runStatus: 'done', questionsJson: '[]',
      createdAt: Date.now() - INVITE_TTL_MS - 5000, expiresAt: Date.now() - 5000, sentAt: null,
    }).run();
    expect(dead.changes).toBe(1);
    expect(pruneExpiredFeedbackInvites()).toBe(1);
    const remaining = db.select().from(feedbackInvites).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(live.id);
  });
});
