import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.norc');
const STATE_FILE = join(STATE_DIR, 'init-state.json');

export interface InitState {
  completedSteps: number[];
  publicUrl?: string;
  notionClientId?: string;
  notionOrgDbId?: string;
  notionTasksDbId?: string;
  notionProjectsDbId?: string;
  lastUpdated: string;
}

export async function readInitState(): Promise<InitState> {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { completedSteps: [], lastUpdated: new Date().toISOString() };
  }
}

export async function writeInitState(state: InitState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({ ...state, lastUpdated: new Date().toISOString() }, null, 2));
}

export async function markStepComplete(step: number): Promise<void> {
  const state = await readInitState();
  if (!state.completedSteps.includes(step)) {
    state.completedSteps.push(step);
    await writeInitState(state);
  }
}

export async function isStepComplete(step: number): Promise<boolean> {
  const state = await readInitState();
  return state.completedSteps.includes(step);
}

export async function resetInitState(): Promise<void> {
  await writeInitState({ completedSteps: [], lastUpdated: new Date().toISOString() });
}
