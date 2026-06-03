<!-- /autoplan restore point: /Users/greg/.gstack/projects/norc_ochestrator/main-autoplan-restore-20260603-192534.md -->
# PLAN: Agent Self-Registration, Dashboard Connection Testing & Lineage

**Branch:** main  
**Status:** DRAFT — pending /autoplan review  
**Date:** 2026-06-03  

---

## Summary

NORC currently requires agents to be registered manually via the CLI (`norc agent add`). There is no way for an agent to self-register, no dashboard-level connection testing, and no lineage model for parent→child routing decisions. This plan adds three tightly related capabilities:

1. **Agent Self-Registration via Invitation Prompt** — A shareable prompt block visible on the Dashboard Agents page that any AI agent (OpenClaw, Cursor, Claude Code, etc.) can paste as a system prompt. The agent then calls `POST /api/agents/register` with its capabilities, and NORC persists it locally + in the Notion Org DB.

2. **Dashboard Connection Test** — A "Test Connection" button per agent row that fires a lightweight ping→echo round-trip and reports latency + health.

3. **Lineage Model** — An `parentAgent` field on each AgentEntry, surfaced in the dashboard as a tree view, and used by the orchestrator to route delegation decisions (when `next_agent` is set, prefer agents that are children of the current agent before escalating up the lineage).

---

## Scope

### In scope
- `POST /api/agents/register` — public self-registration endpoint
- `GET /api/agents/invite` — returns the invitation prompt text + NORC server URL
- `POST /api/agents/:name/ping` — connection health check endpoint
- Dashboard: Invitation Prompt panel with copy-to-clipboard
- Dashboard: "Test" button per agent row with live status
- Dashboard: Lineage tree view (expandable parent→children)
- `AgentEntry` schema extension: `parentAgent?: string`, `registeredAt: string`, `capabilities: string[]`
- Notion Org DB sync: write self-registered agents as pages in the Org DB
- CLI: `norc agent invite` — prints the invitation prompt to terminal (for non-dashboard users)

### Out of scope (deferred to TODOS.md)
- Full RBAC / per-agent scoped tokens (v2 — NORC_REGISTRATION_TOKEN is a shared secret, not per-agent)
- Multi-tenant agent isolation (v2 feature)
- Budget / cost tracking per agent (Paperclip concept, future)
- Heartbeat / keep-alive loop (agents don't ping periodically in v1)
- Cursor adapter (they can receive the invitation prompt but need a separate adapter)

---

## Technical Design

### 0. Security: NORC_REGISTRATION_TOKEN

All self-registration and invite endpoints require `Authorization: Bearer <NORC_REGISTRATION_TOKEN>` header. The token is set in `.env` alongside `NORC_PUBLIC_URL`. If the env var is not set, both endpoints return 501 Not Implemented with a helpful message. The invitation prompt text includes the curl command with `Authorization: Bearer {token}` placeholder — operators replace the placeholder with their real token before sharing.

### 1. Self-Registration Endpoint

```
POST /api/agents/register
Headers: Authorization: Bearer <NORC_REGISTRATION_TOKEN>
Body: {
  name: string,
  adapter: "ClaudeCodeAdapter" | "generic",
  capabilities: string[],
  contextLevel: "task" | "project" | "strategic",
  parentAgent?: string,
  workDir?: string
}
Response: {
  registered: true,
  agentId: string,
  callbackBase: string,    // NORC_PUBLIC_URL — agent stores this
  norcVersion: string
}
```

Implementation in `src/index.ts` — new route. Calls `appendAgent()` from `cli/lib/env-file.ts` + a new `createOrgDbAgentPage()` in `src/notion/client.ts` to write the agent as a page in the Org DB.

### 2. Invitation Prompt

`GET /api/agents/invite` returns:

```json
{
  "norcUrl": "https://your-norc.example.com",
  "prompt": "<the full NORC Orchestration Protocol text with real URLs substituted>",
  "registrationPayload": {
    "name": "<YOUR_AGENT_NAME>",
    "adapter": "generic",
    "capabilities": [],
    "contextLevel": "project"
  }
}
```

The full invitation prompt text is the existing `EXECUTION_PROTOCOL` constant from `src/cli/commands/agent.ts`, extended with:
- The actual `NORC_PUBLIC_URL` substituted in for `{callback_url}` examples
- A self-registration curl command at the top: `curl -X POST {norcUrl}/api/agents/register -d '{...}'`

### 3. Dashboard — Invitation Prompt Panel

Add to `dashboard/src/pages/Agents.tsx`:
- A collapsible "Invite an Agent" panel at the top of the page
- Fetches `GET /api/agents/invite`
- Shows a monospace textarea with the full prompt
- "Copy" button with a "Copied!" flash state
- Instructions: "Paste this into your agent's system prompt (OpenClaw persona, Cursor rules file, Claude Code CLAUDE.md, etc.). The agent will self-register with NORC on first run."

### 4. Dashboard — Connection Test

Per agent row, add a "Test" button column:
- Calls `POST /api/agents/:name/ping`
- Shows spinner → green "●  OK  42ms" or red "●  Timeout"
- Backend: `ping` endpoint attempts a minimal dispatch (no actual task) by checking the agent is in `agents.json` + org cache, then does a loopback health check

For Claude Code agents: ping calls `claude --version` via the adapter and returns success/failure + version string.

### 5. Lineage Model

Extend `AgentEntry` in `src/cli/lib/env-file.ts`:
```typescript
export interface AgentEntry {
  name: string;
  orgDbPageId: string;
  adapter: 'ClaudeCodeAdapter';
  authEnv: string;
  timeoutMin: number;
  contextLevel: 'task' | 'project' | 'strategic';
  parentAgent?: string;          // NEW
  registeredAt?: string;         // NEW
  capabilities?: string[];       // NEW
}
```

Dispatcher change in `src/queue/dispatcher.ts`: when `output.nextAgent` is set, check if the named agent is a child of the current agent first (same parent). Log the lineage decision to the task comments: `"Delegating to @child-agent (lineage: child of @current-agent)"`.

Dashboard lineage view: group agents by `parentAgent` in a simple indented list.

---

### 6. EXECUTION_PROTOCOL Rewrite (Two-Phase)

Rewrite the invitation prompt as two clearly labeled phases:

```
## BOOTSTRAP ONCE (on first load)
If you have not yet registered with NORC, execute:
curl -X POST {NORC_URL}/api/agents/register \
  -H "Authorization: Bearer {YOUR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"{YOUR_AGENT_NAME}","adapter":"generic","capabilities":[],"contextLevel":"project"}'

Wait for: {"registered":true} — then you are ready to receive tasks.

## FOR EACH TASK containing [NORC EXECUTION CONTRACT]
1. REPORT COMPLETION: POST to callback_url (from the contract):
   curl -X POST <callback_url from contract> \
     -H "Authorization: Bearer <callback_token from contract>" \
     -H "Content-Type: application/json" \
     -d '{"status":"done","output":"...","summary":"..."}'
   Also emit: NORC_OUTPUT: {"status":"done","summary":"...","next_agent":null}

2. DELEGATE: Set next_agent to another agent's name.
3. CHECKPOINT: For tasks >5 min, POST to checkpoint_url from the contract.
```

### 7. Error Response Shape

All 4xx/5xx from NORC registration/invite/ping return:
```json
{
  "error": "short machine-readable code",
  "message": "human-readable sentence",
  "hint": "how to fix this"
}
```

Examples:
- 401: `{"error":"invalid_token","message":"Authorization token is wrong or missing","hint":"Set NORC_REGISTRATION_TOKEN in .env and pass it as Bearer token"}`
- 400: `{"error":"invalid_name","message":"Agent name must match [a-z0-9_-]+","hint":"Use lowercase letters, numbers, hyphens, underscores only"}`
- 501: `{"error":"not_configured","message":"NORC_REGISTRATION_TOKEN not set","hint":"Add NORC_REGISTRATION_TOKEN to .env and restart"}`

## Current Bugs to Fix (Deep Clean)

From the git log and code review:
1. `src/adapters/claude-code.ts`: the adapter does not parse `next_agent` from Claude's stdout — it only returns `success/exitCode/stdout/stderr`. The `output.nextAgent` check in `dispatcher.ts:line ~89` will always be falsy. Fix: parse stdout for a JSON block containing `next_agent`.
2. `src/notion/org-cache.ts`: Redis connection created lazily but never closed — leaks on health check. Fix: reuse connection singleton + close on process exit.
3. Dashboard `Agents.tsx`: `lastActive` always shows `—` because the API never returns it. Fix: store `lastDispatchAt` in agents.json and return it.
4. `src/triggers/webhook.ts`: `test_mode: true` bypass in `testAgent()` skips signature but still goes through the full webhook path including Notion API calls. Fix: gate the real Notion calls behind `!event.test_mode`.
5. `docker-compose.yml` line 26: `~/.norc:/root/.norc:ro` — must change `:ro` to `:rw` for self-registration writes.
6. `src/notion/org-cache.ts`: `findAgentByName` uses `.includes()` — fix to exact match first, substring as fallback only.
7. `src/queue/dispatcher.ts` BullMQ lock: remove manual `job.updateProgress()` keepAlive, rely on BullMQ's built-in lock renewal.
8. `.env.example`: add `NORC_REGISTRATION_TOKEN=` placeholder with comment.

---

## Test Plan

- Unit: `POST /api/agents/register` — valid body creates agent, duplicate name updates, missing `name` returns 400
- Unit: `GET /api/agents/invite` — returns prompt with real NORC_PUBLIC_URL substituted
- Unit: `POST /api/agents/:name/ping` — known agent returns ok, unknown agent returns 404
- Unit: Lineage dispatch — `output.nextAgent` set → dispatcher picks child agent before unknown agent
- Integration: Self-registration round-trip — POST register → GET /api/agents → agent appears
- E2E: Dashboard invitation prompt — copy button populates clipboard with curl command
- E2E: Dashboard test button — shows spinner then result

---

## Effort

- Backend (3 new endpoints + lineage + bug fixes): ~4 hours CC
- Dashboard UI (invitation panel + test button + lineage tree): ~3 hours CC
- Total human review + config: ~30 min

---

## GSTACK REVIEW REPORT

### Phase 1 — CEO Review (SELECTIVE EXPANSION)

**Security Issue (BOTH models, critical):** `POST /api/agents/register` is public with zero auth. `appendAgent()` upserts by name silently. Anyone reaching NORC_PUBLIC_URL (which is internet-exposed for Notion webhooks) can register or overwrite any agent. FIX: add `NORC_REGISTRATION_TOKEN` env var, require `Authorization: Bearer <token>` header on register + invite endpoints. One env var, one header check.

**CEO Consensus:**
- Premises mostly valid EXCEPT "no auth in v1" — wrong for this deployment model
- Right problem to solve — CONFIRMED
- Scope slightly over-built (lineage routing is premature) — CONFIRMED
- Alternatives not fully explored — CONFIRMED
- next_agent parsing bug must be fixed before lineage code ships

**Decision Audit Trail:**

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|---------|
| 1 | CEO | Mode: SELECTIVE EXPANSION | Mechanical | P2+P5 | Hold scope, cherry-pick security fix | SCOPE EXPANSION |
| 2 | CEO | Security: add NORC_REGISTRATION_TOKEN | Security/Feasibility | P1 | Both models flag as critical, not preference | Defer to v2 |
| 3 | CEO | Lineage routing: schema only, no behavior change | Taste | P5+P3 | No real topology yet, defer behavior | Full routing logic |
| 4 | CEO | next_agent parsing: promote to prerequisite gate | Mechanical | P6 | Delegation broken until fixed | Include as cleanup |
| 5 | CEO | GET /api/agents/invite: client-side URL substitution | Mechanical | P5 | Avoids leaking NORC_PUBLIC_URL on unauthenticated get | Server returns URL |
