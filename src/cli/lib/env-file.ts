import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

const ENV_FILE = '.env';
const NORC_DIR = join(homedir(), '.norc');
const AGENTS_FILE = join(NORC_DIR, 'agents.json');

export async function writeEnvVar(key: string, value: string): Promise<void> {
  let content = '';
  if (existsSync(ENV_FILE)) {
    content = await readFile(ENV_FILE, 'utf-8');
  }

  const lines = content.split('\n');
  const idx = lines.findIndex(l => l.startsWith(key + '='));
  const newLine = `${key}=${value}`;

  if (idx >= 0) {
    lines[idx] = newLine;
  } else {
    lines.push(newLine);
  }

  await writeFile(ENV_FILE, lines.join('\n').trim() + '\n');
}

export async function readEnvVar(key: string): Promise<string | null> {
  if (!existsSync(ENV_FILE)) return null;
  const content = await readFile(ENV_FILE, 'utf-8');
  const line = content.split('\n').find(l => l.startsWith(key + '='));
  return line ? line.slice(key.length + 1).trim() : null;
}

export interface AgentEntry {
  name: string;
  orgDbPageId: string;
  adapter: 'ClaudeCodeAdapter';
  authEnv: string;
  timeoutMin: number;
  contextLevel: 'task' | 'project' | 'strategic';
}

export async function readAgentsJson(): Promise<AgentEntry[]> {
  try {
    const content = await readFile(AGENTS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

export async function writeAgentsJson(agents: AgentEntry[]): Promise<void> {
  await mkdir(NORC_DIR, { recursive: true });
  await writeFile(AGENTS_FILE, JSON.stringify(agents, null, 2));
}

export async function appendAgent(agent: AgentEntry): Promise<void> {
  const existing = await readAgentsJson();
  const idx = existing.findIndex(a => a.name === agent.name);
  if (idx >= 0) {
    existing[idx] = agent;
  } else {
    existing.push(agent);
  }
  await writeAgentsJson(existing);
}
