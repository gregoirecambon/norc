import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';

const CONFIG_DIR = join(homedir(), '.norc');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface NorcConfig {
  notionApiKey?: string;
  notionWebhookSecret?: string;
  notionOrgDbId?: string;
  notionTasksDbId?: string;
  notionProjectsDbId?: string;
  notionPipelineConfigDbId?: string;
  notionParentPageId?: string;
  companyPageId?: string;
  setupComplete?: boolean;
  registrationToken?: string;
}

export async function readConfig(): Promise<NorcConfig> {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function writeConfig(config: NorcConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export async function setConfigValue(key: keyof NorcConfig, value: string | boolean): Promise<void> {
  const config = await readConfig();
  (config as any)[key] = value;
  await writeConfig(config);
}

export function generateWebhookSecret(): string {
  return 'norc_' + randomBytes(24).toString('hex');
}

export function generateRegistrationToken(): string {
  return randomBytes(32).toString('hex');
}

// Load config into process.env so the rest of the codebase
// can use process.env without knowing about config.json
export async function loadConfigIntoEnv(): Promise<void> {
  if (!existsSync(CONFIG_FILE)) return;

  const config = await readConfig();

  if (config.notionApiKey)              process.env.NOTION_API_KEY              = config.notionApiKey;
  if (config.notionWebhookSecret)       process.env.NOTION_WEBHOOK_SECRET       = config.notionWebhookSecret;
  if (config.notionOrgDbId)            process.env.NOTION_ORG_DB_ID            = config.notionOrgDbId;
  if (config.notionTasksDbId)          process.env.NOTION_TASKS_DB_ID          = config.notionTasksDbId;
  if (config.notionProjectsDbId)       process.env.NOTION_PROJECTS_DB_ID       = config.notionProjectsDbId;
  if (config.notionPipelineConfigDbId) process.env.NOTION_PIPELINE_CONFIG_DB_ID = config.notionPipelineConfigDbId;
  if (config.companyPageId)            process.env.NORC_COMPANY_PAGE_ID        = config.companyPageId;
  if (config.registrationToken && !process.env.NORC_REGISTRATION_TOKEN) {
    process.env.NORC_REGISTRATION_TOKEN = config.registrationToken;
  }
}
