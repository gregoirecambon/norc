// Heartbeat — periodic agent liveness. Pings every registered agent, records the
// result locally (agents.status / lastPingedAt / lastLatencyMs), and reflects it
// on the agent's Notion Org DB Status: reachable → Available, unreachable →
// Offline. It never touches an agent that is mid-task (an in-flight run) or one a
// human has marked Busy, so it can't clobber real work.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, notionIntegration } from '../db/schema.js';
import { pingAgent } from '../adapters/index.js';
import { setAgentStatus, touchLastActive } from './notion-writeback.js';
import { notionGet } from './notion-client.js';
import { getSelect } from './notion-props.js';
import { hasInFlightRun } from './runs.js';
import { emitLog } from './logger.js';
import { emitEvent } from './events.js';
import type { Agent, AdapterType, AgentStatus } from '../types.js';

const CONCURRENCY = 4;

/** Ping every agent, update local + Notion status. Returns how many were checked. */
export async function runHeartbeat(): Promise<{ checked: number }> {
  const rows = db.select().from(agents).all();
  if (rows.length === 0) return { checked: 0 };

  const integration = db.select().from(notionIntegration).all()[0] ?? null;
  const apiKey = integration && integration.status === 'active' ? integration.apiKey : null;

  let checked = 0;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async row => {
      let config: Record<string, unknown>;
      try { config = JSON.parse(row.adapterConfig); } catch { config = {}; }
      const agent: Agent = {
        id: row.id, name: row.name, adapterType: row.adapterType as AdapterType,
        adapterConfig: config, status: row.status as AgentStatus,
        lastPingedAt: row.lastPingedAt ?? null, lastLatencyMs: row.lastLatencyMs ?? null,
        registeredAt: row.registeredAt, metadata: {},
      };

      const result = await pingAgent(agent);
      const status: AgentStatus = result.ok ? 'connected' : 'unreachable';
      const now = Date.now();
      db.update(agents).set({ status, lastPingedAt: now, lastLatencyMs: result.latencyMs })
        .where(eq(agents.id, row.id)).run();
      emitEvent({ type: 'agent.updated', data: { id: row.id, status, lastPingedAt: now, lastLatencyMs: result.latencyMs } });

      // Reflect on Notion — but never override a working/Busy agent.
      if (apiKey && row.orgDbPageId && !hasInFlightRun(row.id)) {
        await reflectOrgDbStatus(apiKey, row.orgDbPageId, result.ok);
      }
      checked++;
    }));
  }

  emitLog(`heartbeat: checked ${checked} agent(s)`);
  return { checked };
}

/** Set Org DB Status to Available/Offline, skipping Busy and no-op writes. */
async function reflectOrgDbStatus(apiKey: string, orgDbPageId: string, reachable: boolean): Promise<void> {
  try {
    const page = await notionGet<Record<string, unknown>>(apiKey, `/pages/${orgDbPageId}`);
    const current = getSelect(page['properties'], 'Status');
    if (current === 'Busy') return; // don't disturb a working agent
    if (reachable) {
      if (current !== 'Available') await setAgentStatus(apiKey, orgDbPageId, 'Available');
      await touchLastActive(apiKey, orgDbPageId);
    } else if (current !== 'Offline') {
      await setAgentStatus(apiKey, orgDbPageId, 'Offline');
    }
  } catch {
    // best-effort: a Notion read/write failure shouldn't break the heartbeat
  }
}
