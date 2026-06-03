# NORC — Deferred Scope

Items auto-deferred by /autoplan review (2026-06-03).

## From current PR (Agent Self-Registration)

- **SQLite migration** — agents.json grows with each new field; migrate to SQLite before `>20 agents`
- **Per-agent scoped tokens** — NORC_REGISTRATION_TOKEN is a shared secret; v2 needs per-agent JWT tokens
- **Capabilities-based routing** — routing by capabilities match vs. lineage tree; add when multi-agent topology is established
- **Heartbeat / keep-alive loop** — periodic agent health pings; add after real agent deployments are running
- **Cursor adapter** — Cursor rules file injection; agents can receive the invitation prompt but need a separate adapter to execute tasks
- **Lineage routing behavior** — dispatcher prefers children when next_agent is set; add after next_agent parsing is confirmed working in production

## Existing backlog

- RBAC / multi-operator access
- Audit log for task dispatch and agent registration
- Multi-tenant agent isolation
