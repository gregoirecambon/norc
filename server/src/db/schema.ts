import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
  orgDbPageId: text('org_db_page_id'),
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

export const notionIntegration = sqliteTable('notion_integration', {
  id:                 text('id').primaryKey(),
  apiKey:             text('api_key').notNull(),
  workspaceName:      text('workspace_name'),
  botName:            text('bot_name'),
  botUserId:          text('bot_user_id'),         // integration bot user id — used for write-back loop prevention
  webhookVerifyToken: text('webhook_verify_token'),
  webhookVerifiedAt:  integer('webhook_verified_at'),   // when the verification secret was received
  status:             text('status').notNull().default('pending_key'),
  parentPageId:       text('parent_page_id'),
  workspaceStatus:    text('workspace_status').notNull().default('not_provisioned'),
  createdAt:          integer('created_at').notNull(),
  updatedAt:          integer('updated_at').notNull(),
});

export const notionDatabases = sqliteTable('notion_databases', {
  id:               text('id').primaryKey(),
  kind:             text('kind').notNull(),       // 'org' | 'tasks' | 'projects' | 'pipeline' | 'company'
  notionDatabaseId: text('notion_database_id').notNull(),
  title:            text('title').notNull(),
  url:              text('url'),
  createdAt:        integer('created_at').notNull(),
});

// Comment ids authored by NORC's own write-back, so incoming comment.created
// webhooks for them are ignored (loop prevention).
export const orchestratorComments = sqliteTable('orchestrator_comments', {
  commentId: text('comment_id').primaryKey(),
  createdAt: integer('created_at').notNull(),
});

// Idempotency keys for triggers we've already acted on, so repeated page edits
// (or webhook redeliveries) don't re-fire the same dispatch. Comment triggers
// key on the comment id; page/property triggers key on page id + agent id.
export const processedTriggers = sqliteTable('processed_triggers', {
  triggerKey: text('trigger_key').primaryKey(),
  createdAt: integer('created_at').notNull(),
});

// Durable log lines for the Logs feed — persisted so they survive page
// refreshes and server restarts; pruned by age (24h retention), never on load.
export const logs = sqliteTable('logs', {
  id:   integer('id').primaryKey({ autoIncrement: true }),
  ts:   integer('ts').notNull(),
  line: text('line').notNull(),
});

// Singleton NORC settings (one row): the co-CEO Orchestrator triage agent and the
// heartbeat. Accessed like notionIntegration — db.select()...all()[0].
export const norcSettings = sqliteTable('norc_settings', {
  id:                       text('id').primaryKey(),
  orchestratorEnabled:      integer('orchestrator_enabled', { mode: 'boolean' }).notNull().default(false),
  orchestratorProvider:     text('orchestrator_provider').notNull().default('anthropic'), // 'anthropic' | 'openai'
  orchestratorApiKey:       text('orchestrator_api_key'),
  orchestratorBaseUrl:      text('orchestrator_base_url'),   // OpenAI-compatible base (e.g. LiteLLM); optional for anthropic
  orchestratorModel:        text('orchestrator_model').notNull().default('claude-sonnet-4-6'),
  orchestratorSystemPrompt: text('orchestrator_system_prompt'),
  autoRouteThreshold:       real('auto_route_threshold').notNull().default(0.7),
  heartbeatEnabled:         integer('heartbeat_enabled', { mode: 'boolean' }).notNull().default(true),
  heartbeatIntervalSec:     integer('heartbeat_interval_sec').notNull().default(60),
  runTimeoutSec:            integer('run_timeout_sec').notNull().default(300),  // dispatch → escalate if no callback
  createdAt:                integer('created_at').notNull(),
  updatedAt:                integer('updated_at').notNull(),
});

// One row per agent dispatch. The opaque `token` is what the agent echoes back
// through the Agent API; NORC resolves token → page so writes land on the right
// Notion page (correlation). agentActed flips true when the agent uses the API,
// so NORC knows not to also post the agent's sync text return.
export const taskRuns = sqliteTable('task_runs', {
  id:               text('id').primaryKey(),
  token:            text('token').notNull().unique(),
  agentId:          text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  pageId:           text('page_id').notNull(),        // the anchor page (conversation lives here)
  taskPageId:       text('task_page_id'),             // set when the anchor is a Task
  anchorKind:       text('anchor_kind').notNull(),    // 'task' | 'project' | 'page'
  triggeringUserId: text('triggering_user_id'),       // who kicked it off — @mentioned on timeout escalation
  manageTaskStatus: integer('manage_task_status', { mode: 'boolean' }).notNull().default(false),
  status:           text('status').notNull().default('in_flight'), // in_flight|done|failed|timed_out
  agentActed:       integer('agent_acted', { mode: 'boolean' }).notNull().default(false),
  createdAt:        integer('created_at').notNull(),
  completedAt:      integer('completed_at'),
});
