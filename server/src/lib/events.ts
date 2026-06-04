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
  data: { id: string; adapterConfig?: Record<string, unknown>; orgDbPageId?: string | null };
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

export type NorcEvent =
  | AgentRegisteredEvent
  | AgentDeletedEvent
  | AgentUpdatedEvent
  | HandshakeUpdatedEvent
  | NotionIntegrationUpdatedEvent
  | NotionVerificationReceivedEvent
  | NotionWorkspaceUpdatedEvent;

const listeners = new Set<(event: NorcEvent) => void>();

export function emitEvent(event: NorcEvent): void {
  for (const fn of listeners) {
    try { fn(event); } catch { /* ignore closed */ }
  }
}

export function attachEventListener(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: NorcEvent) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  };
  listeners.add(send);

  res.on('close', () => listeners.delete(send));
}
