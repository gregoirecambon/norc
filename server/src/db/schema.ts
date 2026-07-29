import { blob, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  // Slack reachability. slackEnabled gates whether this agent is targetable
  // from Slack; slackUsergroupId/slackHandle hold the per-agent user group
  // (@handle) NORC provisioned for it — null on free plans (fallback:
  // "@Norc <Name> …"). The usergroup is disabled (kept) on toggle-off.
  slackEnabled:      integer('slack_enabled', { mode: 'boolean' }).notNull().default(false),
  slackUsergroupId:  text('slack_usergroup_id'),
  slackHandle:       text('slack_handle'),
  // Avatar mirrored from the agent's Notion page icon at sync time, so Slack
  // and the dashboard serve it without a live Notion round-trip.
  avatar:     blob('avatar', { mode: 'buffer' }),
  avatarType: text('avatar_type'),
  avatarAt:   integer('avatar_at'),
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
  norcOrgPageId:      text('norc_org_page_id'),     // NORC's own Org DB page (Type = Orchestrator)
  createdAt:          integer('created_at').notNull(),
  updatedAt:          integer('updated_at').notNull(),
});

// Singleton Slack workspace connection (one row, like notionIntegration).
// botToken/signingSecret may be null when the install relies on the
// SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET env fallback — resolution lives in
// lib/slack-integration.ts. botUserId is our app's bot user, used both for
// loop prevention (ignore our own messages) and to detect @Norc mentions.
export const slackIntegration = sqliteTable('slack_integration', {
  id:            text('id').primaryKey(),
  botToken:      text('bot_token'),
  signingSecret: text('signing_secret'),
  botUserId:     text('bot_user_id'),
  appId:         text('app_id'),
  teamId:        text('team_id'),
  teamName:      text('team_name'),
  botName:       text('bot_name'),
  status:        text('status').notNull().default('pending'), // 'pending' | 'active' | 'error'
  createdAt:     integer('created_at').notNull(),
  updatedAt:     integer('updated_at').notNull(),
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
  // Co-CEO memory + cost controls. ceoMemo is the bounded cross-portfolio rolling
  // memo (per-project slices live in project_memo). autoProposeSummaryModel is the
  // cheaper model used for the incremental memo step (falls back to orchestratorModel).
  ceoMemo:                  text('ceo_memo'),
  ceoMemoUpdatedAt:         integer('ceo_memo_updated_at'),
  autoProposeSummaryModel:  text('auto_propose_summary_model'),
  // Phase 2: gated live progress probes — only stale/under-covered projects, rate-limited.
  autoProposeProbeEnabled:       integer('auto_propose_probe_enabled', { mode: 'boolean' }).notNull().default(false),
  autoProposeProbeCooldownHours: integer('auto_propose_probe_cooldown_hours').notNull().default(48),
  // Chores: reusable multi-agent process definitions read by triage (see chores/).
  // choresEnabled gates the whole feature; choresNotionSync is the kill-switch for
  // the Notion mirror (off = run chores purely from server files on disk).
  choresEnabled:            integer('chores_enabled', { mode: 'boolean' }).notNull().default(false),
  choresNotionSync:         integer('chores_notion_sync', { mode: 'boolean' }).notNull().default(true),
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
  // Post-run human feedback invites: sampled at feedbackSampleRate (0–1) and
  // delivered over feedbackChannel ('slack' DM | 'email').
  feedbackEnabled:          integer('feedback_enabled', { mode: 'boolean' }).notNull().default(false),
  feedbackSampleRate:       real('feedback_sample_rate').notNull().default(0.25),
  feedbackChannel:          text('feedback_channel').notNull().default('slack'), // 'slack' | 'email'
  // When true, opening a feedback form requires a signed-in dashboard session.
  // Default false: the invite token in the URL is the whole credential, so the
  // human can rate a run without a NORC account.
  feedbackFormRequiresLogin: integer('feedback_form_requires_login', { mode: 'boolean' }).notNull().default(false),
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
  // The session this run addressed (resolveSession): the NORC key (page / page#chat
  // / page#g2) or, for openclaw, the adapter's own session key. Display/debug only.
  sessionId:        text('session_id'),
  // Where the triggering request came from. Slack-originated runs carry the
  // channel + thread so replies/completions land back in the right Slack thread
  // (for chat runs the anchor itself is synthetic: pageId = slack:<ch>:<ts>).
  origin:           text('origin').notNull().default('notion'), // 'notion' | 'slack'
  slackChannel:     text('slack_channel'),
  slackThreadTs:    text('slack_thread_ts'),
  // Slack user who triggered a slack-origin run. Separate from triggeringUserId
  // (a Notion user id, @mentioned on timeout escalation) — the two id spaces
  // must not mix. Feeds feedback delivery and the top-humans stat.
  triggeringSlackUserId: text('triggering_slack_user_id'),
  // Which NORC tools this run touched — a RunTool bitmask (lib/run-tools.ts),
  // OR-ed in place at the call sites. Drives the per-tool feedback questions.
  toolFlags:        integer('tool_flags').notNull().default(0),
  // Agent-self-reported total token usage from /complete. Best-effort: null
  // when the agent's runtime doesn't report it.
  tokensUsed:       integer('tokens_used'),
  createdAt:        integer('created_at').notNull(),
  completedAt:      integer('completed_at'),
});

// One row per (agent, anchor page, lane). Holds the agent's CURRENT session id and
// the narrow context fingerprint that minted it. A turn reuses the session while the
// fingerprint is unchanged and rebuilds it (epoch++ → a fresh session key) when the
// agent's framing changes. Only session-capable adapters (openclaw today) get rows;
// stateless adapters re-assemble clean each turn and need no session memory.
export const agentSessions = sqliteTable('agent_sessions', {
  id:          text('id').primaryKey(),
  agentId:     text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  pageId:      text('page_id').notNull(),
  lane:        text('lane').notNull().default('work'),  // 'work' | 'chat' (keyed separately)
  sessionId:   text('session_id').notNull(),            // resolved key: page / page#chat / page#g2
  fingerprint: text('fingerprint').notNull(),           // the NARROW session fingerprint
  epoch:       integer('epoch').notNull().default(1),   // monotonic; bumps on each rebuild
  createdAt:   integer('created_at').notNull(),
  updatedAt:   integer('updated_at').notNull(),
}, (t) => ({
  uniq: uniqueIndex('agent_sessions_agent_page_lane_idx').on(t.agentId, t.pageId, t.lane),
}));

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

// NORC self-modification proposals (propose → approve). When the NORC agent is
// asked to change its own configuration (system prompt, thresholds, automations,
// its Org DB profile) it posts a before→after diff comment and parks the change
// here until a human replies "approve"/"reject" in that thread. discussionId is
// the lookup key for matching the verdict reply; same-kind pending rows are
// superseded by newer proposals so a change can never double-apply.
export const pendingSelfChanges = sqliteTable('pending_self_changes', {
  id:                text('id').primaryKey(),
  kind:              text('kind').notNull(),          // SelfChangeKind (see self-changes.ts)
  payloadJson:       text('payload_json').notNull(),  // proposed value(s), kind-specific
  diffText:          text('diff_text').notNull(),     // rendered before→after (display/audit)
  status:            text('status').notNull().default('pending'), // pending|approved|rejected|expired|superseded
  discussionId:      text('discussion_id'),           // Notion thread to watch for the verdict
  pageId:            text('page_id').notNull(),       // where the proposal comment was posted
  proposedCommentId: text('proposed_comment_id'),
  proposedByUserId:  text('proposed_by_user_id'),     // who asked for the change (audit)
  createdAt:         integer('created_at').notNull(),
  resolvedAt:        integer('resolved_at'),
  resolvedByUserId:  text('resolved_by_user_id'),
});

// Per-project rolling co-CEO memo — one bounded slice per Notion project, updated
// incrementally each auto-propose cycle (only when the project's signals changed)
// so the context fed to the LLM stays roughly constant as the portfolio grows.
// `signalHash` lets a cycle skip re-summarizing an unchanged project (no LLM call);
// `lastProbeAt` rate-limits the Phase-2 live progress probes.
export const projectMemo = sqliteTable('project_memo', {
  projectId:   text('project_id').primaryKey(),       // Notion project page id
  title:       text('title'),                         // last-seen project name (display)
  memo:        text('memo').notNull().default(''),    // the rolling slice for this app
  kpiNote:     text('kpi_note'),                      // last qualitative KPI-progress read
  signalHash:  text('signal_hash'),                   // hash of last cycle's signals → skip-if-unchanged
  lastProbeAt: integer('last_probe_at'),              // Phase 2: last live progress probe dispatched
  updatedAt:   integer('updated_at').notNull(),
});

// Pending post-run feedback invites — one row per sampled run, deleted on
// submission or expiry (7 days), so the table stays tiny on small VPSes. The
// token is stored PLAINTEXT (unlike invites.tokenHash): the dashboard needs to
// reconstruct the copy-link/resend URL, and the token only grants "submit one
// rating" — same trust level as taskRuns.token. runId is a plain text snapshot
// key (no FK) so invites survive task_runs pruning; run/agent display fields
// are denormalized for the same reason.
export const feedbackInvites = sqliteTable('feedback_invites', {
  id:            text('id').primaryKey(),
  runId:         text('run_id').notNull(),
  token:         text('token').notNull().unique(),
  channel:       text('channel').notNull(),         // 'slack' | 'email'
  recipient:     text('recipient'),                 // slack user id or email; null = unresolved (copy-link only)
  recipientName: text('recipient_name'),            // display name snapshot
  runTitle:      text('run_title'),
  agentId:       text('agent_id'),
  agentName:     text('agent_name'),
  runStatus:     text('run_status'),                // done|failed|timed_out at mint time
  questionsJson: text('questions_json').notNull(),  // up to 3 {key,label} snapshotted at mint time
  createdAt:     integer('created_at').notNull(),
  expiresAt:     integer('expires_at').notNull(),   // mint + 7 days; the link self-destructs
  sentAt:        integer('sent_at'),                // null = delivery failed / never sent
});

// Submitted feedback. Run/agent fields are denormalized snapshots copied from
// the invite so history survives run pruning and agent deletion.
export const feedbackSubmissions = sqliteTable('feedback_submissions', {
  id:        text('id').primaryKey(),
  runId:     text('run_id'),
  runTitle:  text('run_title'),
  agentId:   text('agent_id'),
  agentName: text('agent_name'),
  rating:    integer('rating').notNull(),           // 1–5 stars
  comment:   text('comment'),
  createdAt: integer('created_at').notNull(),
});

// Per-tool star ratings attached to a submission — normalized (not JSON) so
// the per-tool happiness aggregate is one AVG … GROUP BY tool_key.
export const feedbackToolRatings = sqliteTable('feedback_tool_ratings', {
  id:           text('id').primaryKey(),
  submissionId: text('submission_id').notNull().references(() => feedbackSubmissions.id, { onDelete: 'cascade' }),
  toolKey:      text('tool_key').notNull(),         // 'slack' | 'propose_tasks' | 'remote_worker' | 'triage'
  rating:       integer('rating').notNull(),        // 1–5
});

// A chore whose cast (the resolved step→agent plan) is awaiting human approval
// (chore frontmatter `approval: cast`, or a step that couldn't be confidently
// cast even under `approval: auto`). Mirrors pending_self_changes: the proposal
// comment's discussion id is the lookup key for the "approve"/"reject" reply;
// payloadJson holds the full resolved cast + inputs so an approval can build the
// task DAG without re-resolving. Same-(chore,page) pending rows are superseded.
export const pendingChoreCasts = sqliteTable('pending_chore_casts', {
  id:                text('id').primaryKey(),
  choreId:           text('chore_id').notNull(),       // which chore this cast is for
  sourcePageId:      text('source_page_id').notNull(), // the triggering task/anchor page
  payloadJson:       text('payload_json').notNull(),   // { cast, inputs, projectId } — enough to compile on approve
  castText:          text('cast_text').notNull(),      // rendered step·agent·confidence list (display/audit)
  status:            text('status').notNull().default('pending'), // pending|approved|rejected|expired|superseded
  discussionId:      text('discussion_id'),            // Notion thread to watch for the verdict
  pageId:            text('page_id').notNull(),        // where the cast comment was posted
  proposedCommentId: text('proposed_comment_id'),
  proposedByUserId:  text('proposed_by_user_id'),
  createdAt:         integer('created_at').notNull(),
  resolvedAt:        integer('resolved_at'),
  resolvedByUserId:  text('resolved_by_user_id'),
});

// Non-AI API clients ("apps": n8n flows, custom services…) holding a static key
// to drive NORC headlessly via /api/ext. Deliberately NOT rows in `agents`:
// agents are dispatch targets (heartbeat pings, org routing, handshakes) —
// apps only ever CALL NORC. The key itself is never stored: keyHash is its
// sha256, keyPrefix the short display stub the dashboard shows after creation.
export const apps = sqliteTable('apps', {
  id:          text('id').primaryKey(),
  name:        text('name').notNull().unique(),
  description: text('description'),
  keyHash:     text('key_hash').notNull().unique(),
  keyPrefix:   text('key_prefix').notNull(),
  scopes:      text('scopes').notNull().default('["read"]'), // JSON array: 'read' | 'tasks:write' | 'tasks:approve'
  createdBy:   text('created_by'),        // dashboard user id (informational)
  createdAt:   integer('created_at').notNull(),
  lastUsedAt:  integer('last_used_at'),
  revokedAt:   integer('revoked_at'),     // set → key refused; row kept for audit
  orgDbPageId: text('org_db_page_id'),    // Notion Org DB page, kind "App"
});

// Per-request access trail for app keys — the audit the dashboard shows per
// app. Time-pruned like task_runs so it never grows unbounded.
export const appAccessLog = sqliteTable('app_access_log', {
  id:     text('id').primaryKey(),
  appId:  text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  method: text('method').notNull(),
  path:   text('path').notNull(),
  status: integer('status').notNull(),
  ip:     text('ip'),
  at:     integer('at').notNull(),
});
