// Singleton NORC settings — the co-CEO Orchestrator + heartbeat config. One row,
// accessed like notionIntegration. getOrDefault() returns sane defaults when the
// row doesn't exist yet so callers never special-case "unconfigured".

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { norcSettings } from '../db/schema.js';

export type NorcSettings = typeof norcSettings.$inferSelect;

const DEFAULTS: Omit<NorcSettings, 'id' | 'createdAt' | 'updatedAt'> = {
  orchestratorEnabled: false,
  orchestratorProvider: 'anthropic',
  orchestratorApiKey: null,
  orchestratorBaseUrl: null,
  orchestratorModel: 'claude-sonnet-4-6',
  orchestratorSystemPrompt: null,
  autoRouteThreshold: 0.7,
  heartbeatEnabled: true,
  heartbeatIntervalSec: 60,
  deepPingEnabled: true,
  deepPingIntervalSec: 600,
  failureNotifyThreshold: 2,
  runTimeoutSec: 300,
  schedulerEnabled: false,
  autoProposeEnabled: false,
  autoProposeIntervalHours: 12,
  smtpHost: null,
  smtpPort: null,
  smtpUser: null,
  smtpPass: null,
  smtpFrom: null,
  smtpSecure: false,
};

export function getNorcSettings(): NorcSettings | null {
  return db.select().from(norcSettings).all()[0] ?? null;
}

export function getNorcSettingsOrDefault(): NorcSettings {
  return getNorcSettings() ?? { id: 'default', ...DEFAULTS, createdAt: 0, updatedAt: 0 };
}

type SettingsPatch = Partial<Omit<NorcSettings, 'id' | 'createdAt' | 'updatedAt'>>;

export function upsertNorcSettings(patch: SettingsPatch): NorcSettings {
  const existing = getNorcSettings();
  const now = Date.now();
  if (existing) {
    db.update(norcSettings).set({ ...patch, updatedAt: now }).where(eq(norcSettings.id, existing.id)).run();
  } else {
    db.insert(norcSettings).values({ id: randomUUID(), ...DEFAULTS, ...patch, createdAt: now, updatedAt: now }).run();
  }
  return getNorcSettings()!;
}
