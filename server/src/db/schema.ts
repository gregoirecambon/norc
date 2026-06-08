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
  // Outage tracking (heartbeat). Two consecutive-failure counters: a transport
  // success only proves the gateway is reachable, so it must not reset the deep
  // counter — only a real deep-ping reply does.
  transportFailures: integer('transport_failures').notNull().default(0),
  deepFailures:      integer('deep_failures').notNull().default(0),
  upSinceAt:         integer('up_since_at'),       // start of the current confirmed-up period
  lastOkAt:          integer('last_ok_at'),        // last successful check (any kind)
  downNotifiedAt:    integer('down_notified_at'),  // set once the owner was notified for this outage
  // Dispatch capacity: how many WORK runs may be in flight at once for this
  // agent. Excess work waits in dispatch_queue. Chat-lane runs are exempt.
  maxConcurrentRuns: integer('max_concurrent_runs').notNull().default(1),
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
// refreshes and server restarts; pruned by age (3-day retention), never on load.
// `tag` is the log source: 'NORC' (system), 'Triage', 'Schedule', 'Co-CEO', or an agent name.
// `pageId` (optional) is the Notion page the event relates to — the UI renders
// an "Open in Notion" link when present.
export const logs = sqliteTable('logs', {
  id:     integer('id').primaryKey({ autoIncrement: true }),
  ts:     integer('ts').notNull(),
  tag:    text('tag').notNull().default('NORC'),
  line:   text('line').notNull(),
  pageId: text('page_id'),
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
  deepPingEnabled:          integer('deep_ping_enabled', { mode: 'boolean' }).notNull().default(true),  // real test prompt through each agent's AI
  deepPingIntervalSec:      integer('deep_ping_interval_sec').notNull().default(600),                   // min 60
  failureNotifyThreshold:   integer('failure_notify_threshold').notNull().default(2),                   // tag Owner after N consecutive failures
  runTimeoutSec:            integer('run_timeout_sec').notNull().default(300),  // idle/silence window (was: absolute age): escalate after the agent is silent this long
  runHardCapSec:            integer('run_hard_cap_sec').notNull().default(1800), // absolute ceiling: force-timeout a run regardless of activity (runaway backstop)
  // Proactive automations.
  schedulerEnabled:         integer('scheduler_enabled', { mode: 'boolean' }).notNull().default(false),       // scheduled/recurring task poller
  autoProposeEnabled:       integer('auto_propose_enabled', { mode: 'boolean' }).notNull().default(false),    // recurring co-CEO task proposals
  autoProposeIntervalHours: integer('auto_propose_interval_hours').notNull().default(12),                     // 1–24
  // Outgoing email (team invites). DB values win; SMTP_* env vars are the
  // fallback. host…from columns predate this feature (0013_notifications.sql,
  // unused until now) — smtp_port is nullable there, so the 587 default lives
  // in code; only smtp_secure is new (0020).
  smtpHost:                 text('smtp_host'),
  smtpPort:                 integer('smtp_port'),
  smtpUser:                 text('smtp_user'),
  smtpPass:                 text('smtp_pass'),
  smtpFrom:                 text('smtp_from'),
  smtpSecure:               integer('smtp_secure', { mode: 'boolean' }).notNull().default(false),
  createdAt:                integer('created_at').notNull(),
  updatedAt:                integer('updated_at').notNull(),
});

// Dashboard users (OAuth identities). The first user to sign in on an empty
// table becomes 'owner'; everyone after that must hold a matching invite.
export const users = sqliteTable('users', {
  id:              text('id').primaryKey(),
  email:           text('email').notNull().unique(),   // always lowercased
  name:            text('name'),
  avatarUrl:       text('avatar_url'),
  role:            text('role').notNull().default('member'), // 'owner' | 'admin' | 'member'
  provider:        text('provider'),                   // last provider used: 'google' | 'github'
  providerSubject: text('provider_subject'),           // provider's user id (audit)
  createdAt:       integer('created_at').notNull(),
  lastLoginAt:     integer('last_login_at'),
});

// DB-backed dashboard sessions — the cookie holds an opaque token; only its
// sha256 lives here, so a DB read never yields a usable cookie. Cascade on
// user delete = instant logout.
export const sessions = sqliteTable('sessions', {
  id:         text('id').primaryKey(),
  tokenHash:  text('token_hash').notNull().unique(),
  userId:     text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt:  integer('created_at').notNull(),
  expiresAt:  integer('expires_at').notNull(),
  lastSeenAt: integer('last_seen_at'),
  userAgent:  text('user_agent'),
});

// Team invites. Accepting = signing in via OAuth with the matching email
// (the invite link just pre-fills the token). Token stored hashed, like sessions.
export const invites = sqliteTable('invites', {
  id:         text('id').primaryKey(),
  email:      text('email').notNull(),                 // always lowercased
  role:       text('role').notNull().default('member'), // 'admin' | 'member'
  tokenHash:  text('token_hash').notNull().unique(),
  invitedBy:  text('invited_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt:  integer('created_at').notNull(),
  expiresAt:  integer('expires_at').notNull(),
  acceptedAt: integer('accepted_at'),
  revokedAt:  integer('revoked_at'),
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
  title:            text('title'),                    // page/task title snapshot at dispatch time (display only)
  projectId:        text('project_id'),               // the Notion project this run belongs to (serialization key)
  lane:             text('lane').notNull().default('work'), // 'work' (capacity-gated) | 'chat' (parallel, exempt)
  triggeringUserId: text('triggering_user_id'),       // who kicked it off — @mentioned on timeout escalation
  manageTaskStatus: integer('manage_task_status', { mode: 'boolean' }).notNull().default(false),
  status:           text('status').notNull().default('in_flight'), // in_flight|done|failed|timed_out
  agentActed:       integer('agent_acted', { mode: 'boolean' }).notNull().default(false),
  // Liveness: bumped on every Agent-API call (proof of life). The timeout sweep
  // measures SILENCE from here, not age from createdAt, so a working-but-slow
  // agent isn't false-killed. NULL on legacy rows → coalesced to createdAt.
  lastProgressAt:   integer('last_progress_at'),
  // OpenClaw-side run handle, persisted on async dispatch so the timeout sweep can
  // probe "are you still executing?" (agent.wait) before escalating.
  openclawRunId:    text('openclaw_run_id'),
  createdAt:        integer('created_at').notNull(),
  completedAt:      integer('completed_at'),
});

// Work waiting for agent capacity. A turn that can't dispatch (the agent is at
// its maxConcurrentRuns cap, or already has an in-flight run on the same
// project/page) parks here and is drained FIFO as runs finalize. `payload` is
// the serialized turn (request, discussion ids, …) minus the comment thread,
// which is re-fetched fresh at drain time. Integer PK = free FIFO ordering.
export const dispatchQueue = sqliteTable('dispatch_queue', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  agentId:       text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  pageId:        text('page_id').notNull(),
  taskPageId:    text('task_page_id'),
  projectId:     text('project_id'),
  anchorKind:    text('anchor_kind').notNull(),  // 'task' | 'project' | 'page'
  title:         text('title'),
  payload:       text('payload').notNull(),      // JSON QueuedTurn
  // Higher drains first (then FIFO). 0 = normal webhook work; 1 = priority —
  // e.g. a task an agent claimed from an out-of-band (Slack) request.
  priority:      integer('priority').notNull().default(0),
  status:        text('status').notNull().default('pending'), // pending|dispatched|dropped
  enqueuedAt:    integer('enqueued_at').notNull(),
  dispatchedAt:  integer('dispatched_at'),
  droppedReason: text('dropped_reason'),
});
