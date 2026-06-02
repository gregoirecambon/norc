import Redis from 'ioredis';
import { getOrgDbAgents } from './client.js';

const CACHE_KEY = 'norc:org-db-agents';
const TTL_SECONDS = 5 * 60;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  }
  return redis;
}

export type AgentRecord = {
  id: string;
  name: string;
  specialty: string;
  contextLevel: 'task' | 'project' | 'strategic';
};

export async function getCachedAgents(): Promise<AgentRecord[]> {
  const r = getRedis();
  const cached = await r.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const agents = await getOrgDbAgents();
  await r.setex(CACHE_KEY, TTL_SECONDS, JSON.stringify(agents));
  return agents as AgentRecord[];
}

export async function findAgentByPageId(pageId: string): Promise<AgentRecord | null> {
  const agents = await getCachedAgents();
  return agents.find(a => a.id === pageId) ?? null;
}

export async function findAgentByName(name: string): Promise<AgentRecord | null> {
  const agents = await getCachedAgents();
  const lower = name.toLowerCase();
  return agents.find(a => a.name.toLowerCase().includes(lower)) ?? null;
}

export async function isAgentPageId(pageId: string): Promise<boolean> {
  return (await findAgentByPageId(pageId)) !== null;
}

export async function invalidateCache(): Promise<void> {
  await getRedis().del(CACHE_KEY);
}
