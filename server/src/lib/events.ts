import type { Response } from 'express';

export interface AgentRegisteredEvent {
  type: 'agent.registered';
  data: {
    id: string;
    name: string;
    adapterType: string;
    adapterConfig: Record<string, unknown>;
    status: string;
    lastPingedAt: number | null;
    lastLatencyMs: number | null;
    registeredAt: number;
    metadata: Record<string, unknown>;
    orgDbPageId: string | null;
  };
}

export interface AgentDeletedEvent {
  type: 'agent.deleted';
  data: { id: string };
}

export interface AgentUpdatedEvent {
  type: 'agent.updated';
  data: {
    id: string;
    adapterConfig?: Record<string, unknown>;
    orgDbPageId?: string | null;
    status?: string;
    lastPingedAt?: number | null;
    lastLatencyMs?: number | null;
    maxConcurrentRuns?: number;
    slackEnabled?: boolean;
    slackHandle?: string | null;
  };
}

export interface HandshakeUpdatedEvent {
  type: 'handshake.updated';
  data: { handshakeId: string; agentId: string; status: string; latencyMs: number | null; error: string | null };
}

export interface NotionIntegrationUpdatedEvent {
  type: 'notion.integration.updated';
  data: {
    status: string;
    workspaceName: string | null;
    botName: string | null;
    webhookVerifyToken: string | null;
    webhookUrl: string;
  };
}

export interface NotionVerificationReceivedEvent {
  type: 'notion.verification_received';
  data: {
    verificationToken: string;
    workspaceName: string | null;
    botName: string | null;
  };
}

export interface NotionWorkspaceUpdatedEvent {
  type: 'notion.workspace.updated';
  data: {
    workspaceStatus: string;
    parentPageId: string | null;
    databases: { kind: string; notionDatabaseId: string; title: string; url: string | null }[];
  };
}

export interface SlackIntegrationUpdatedEvent {
  type: 'slack.integration.updated';
  data: {
    status: string;
    teamName: string | null;
    botName: string | null;
    source: 'settings' | 'env' | null;
  };
}

export interface MentionDetectedEvent {
  type: 'mention.detected';
  data: { agentId: string; agentName: string; pageId: string; anchorKind: string };
}

export interface RunStartedEvent {
  type: 'run.started';
  data: {
    id: string;
    agentId: string;
    agentName: string;
    title: string | null;
    anchorKind: string;
    pageId: string;
    createdAt: number;
  };
}

export interface RunFinishedEvent {
  type: 'run.finished';
  data: { id: string; agentId: string; status: 'done' | 'failed' | 'timed_out'; completedAt: number };
}

/** The dispatch queue changed for an agent (enqueue/claim/drop). `pending` is
 * the agent's fresh pending count so consumers can render without re-querying. */
export interface QueueUpdatedEvent {
  type: 'queue.updated';
  data: { agentId: string; pending: number };
}

/** Public app row (never the key or its hash) — created/updated/revoked from the dashboard. */
export interface AppChangedEvent {
  type: 'app.created' | 'app.updated' | 'app.deleted';
  data: { id: string; name: string };
}

export type NorcEvent =
  | AppChangedEvent
  | AgentRegisteredEvent
  | AgentDeletedEvent
  | AgentUpdatedEvent
  | HandshakeUpdatedEvent
  | NotionIntegrationUpdatedEvent
  | NotionVerificationReceivedEvent
  | NotionWorkspaceUpdatedEvent
  | SlackIntegrationUpdatedEvent
  | MentionDetectedEvent
  | RunStartedEvent
  | RunFinishedEvent
  | QueueUpdatedEvent;

const listeners = new Set<(event: NorcEvent) => void>();

export function emitEvent(event: NorcEvent): void {
  for (const fn of listeners) {
    try { fn(event); } catch { /* ignore closed */ }
  }
}

/** Subscribe an in-process listener (e.g. the queue drain reacting to
 * run.finished). Returns the unsubscribe function. Emission is synchronous —
 * heavy work should hop off the emitter's stack (setImmediate). */
export function onEvent(fn: (event: NorcEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function attachEventListener(res: Response, filter?: (event: NorcEvent) => boolean): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: NorcEvent) => {
    if (filter && !filter(event)) return;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  };
  listeners.add(send);

  res.on('close', () => listeners.delete(send));
}
