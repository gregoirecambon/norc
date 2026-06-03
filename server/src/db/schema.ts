import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  adapterType: text('adapter_type').notNull(),
  adapterConfig: text('adapter_config').notNull().default('{}'),
  agentSecret: text('agent_secret'),
  status: text('status').notNull().default('untested'),
  lastPingedAt: integer('last_pinged_at'),
  lastLatencyMs: integer('last_latency_ms'),
  registeredAt: integer('registered_at').notNull(),
  metadata: text('metadata').notNull().default('{}'),
});

export const registrationTokens = sqliteTable('registration_tokens', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  usedAt: integer('used_at'),
  usedByAgent: text('used_by_agent'),
});

export const connectionTests = sqliteTable('connection_tests', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  latencyMs: integer('latency_ms'),
  error: text('error'),
  testedAt: integer('tested_at').notNull(),
});

export const platforms = sqliteTable('platforms', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  apiKey: text('api_key').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const agentPlatformGrants = sqliteTable('agent_platform_grants', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  platformId: text('platform_id').notNull().references(() => platforms.id, { onDelete: 'cascade' }),
  grantedAt: integer('granted_at').notNull(),
});

export const handshakes = sqliteTable('handshakes', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  nonce: text('nonce').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at').notNull(),
  completedAt: integer('completed_at'),
  latencyMs: integer('latency_ms'),
  error: text('error'),
});
