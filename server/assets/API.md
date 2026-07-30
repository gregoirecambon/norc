# NORC API

Drive NORC without the dashboard: create tasks, read what the team is working
on, pull stats, and follow live events — from n8n, a custom service, a script,
or an AI agent.

This document is served by every NORC install at `{{NORC_URL}}/api/docs`
(no auth required), so you can share that URL directly with an integrator.

---

## Authentication

Every endpoint under `/api/ext/*` takes a single Bearer credential:

```
Authorization: Bearer <credential>
```

Two kinds of credential work:

| Credential | Who | How to get one |
|---|---|---|
| **App key** (`norc_app_…`) | Non-AI clients: n8n, custom backends, scripts | Dashboard → AI Agents → **+ Add App**. The key is shown **once** — store it in a secret manager. |
| **Agent secret** | Registered AI agents | Returned by `POST /api/agents/register` during the agent invite flow. |

Keys are stored hashed server-side and can be rotated or revoked from the
dashboard at any time. Every authenticated app request is recorded in a
per-app access log (visible in the dashboard, 90-day retention).

### Scopes

Each app key carries scopes, chosen when the key is created:

| Scope | Grants |
|---|---|
| `read` | All GET endpoints + the event stream |
| `tasks:write` | `POST /api/ext/tasks` (tasks land as **Proposed**) |
| `tasks:approve` | Approve/dismiss proposals, and `route: true` on task creation |

Agent secrets implicitly hold `read` + `tasks:write`.

Missing scope → `403 {"error":"forbidden"}`.

---

## Quick start

```bash
# Am I wired up?
curl -H "Authorization: Bearer $KEY" {{NORC_URL}}/api/ext/me
# → {"kind":"app","id":"…","name":"n8n","scopes":["read","tasks:write"]}

# Create a task
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"title":"Refresh the pricing page","project":"Site v2","description":"Q3 prices are live"}' \
  {{NORC_URL}}/api/ext/tasks
```

---

## Endpoints

All routes live under `{{NORC_URL}}/api/ext`.

### `GET /me`

Identity echo — use it as a connectivity/credential probe.

```json
{ "kind": "app", "id": "…", "name": "n8n", "scopes": ["read", "tasks:write"] }
```

### `GET /agents` — scope `read`

The agent registry, redacted (no adapter configuration).

```json
[{ "id": "…", "name": "alpha", "adapterType": "http", "status": "connected",
   "lastPingedAt": 1785300000000, "maxConcurrentRuns": 1, "registeredAt": 1785000000000 }]
```

`status` is `connected` | `unreachable` | `untested`.

### `GET /dashboard` — scope `read`

Who is working right now. Same data as the dashboard's home view, minus
operator-only fields (session links, SSH/resume metadata).

```json
{
  "activeRuns":  [{ "id": "…", "agentId": "…", "agentName": "alpha", "title": "…",
                    "status": "in_flight", "createdAt": 1785300000000, "completedAt": null, "…": "…" }],
  "recentRuns":  ["… last 20 finished runs …"],
  "queued":      [{ "id": 1, "agentId": "…", "agentName": "alpha", "title": "…", "priority": 0, "enqueuedAt": 1785300000000 }],
  "stats":       { "activeRuns": 1, "queuedItems": 0, "agentsConnected": 2, "agentsTotal": 3 }
}
```

### `GET /stats?days=7|30|90` — scope `read`

Historical aggregates over the last N days (default 30). Includes total runs,
error rate, average duration, per-day done/failed series, top agents (runs,
duration, self-reported tokens), top triggering humans, and token totals.

### `GET /projects` — scope `read`

The project roster from the Notion Projects database.

```json
[{ "id": "<notion-page-id>", "name": "Site v2" }]
```

### `GET /tasks?project=<name-or-id>&q=<keywords>` — scope `read`

Open (non-terminal) tasks. `project` accepts a Notion page id or a project
name (case-insensitive; unique-contains match). `q` scores results by title
similarity.

```json
{ "project": { "id": "…", "name": "Site v2" },
  "tasks": [{ "id": "…", "title": "Fix login bug", "status": "Backlog",
              "url": "https://notion.so/…", "assignedTo": ["alpha"] }] }
```

### `POST /tasks` — scope `tasks:write`

Create a task, behind NORC's duplicate gate.

Body:

| Field | Type | Notes |
|---|---|---|
| `title` | string | required |
| `description` | string | becomes the task page body |
| `kpis` | string | success criteria |
| `project` | string | Notion page id or project name |
| `force` | boolean | bypass the duplicate gate |
| `route` | boolean | apps only — create into Backlog and hand straight to the orchestrator (**requires `tasks:approve`**) |
| `source` | string | free-form origin label for the audit trail |

Behavior by credential:

- **Apps** create tasks **unassigned**. Default status is `Proposed` (a human
  validates it in the dashboard). With `route: true` the task lands in
  `Backlog` and NORC's orchestrator routes it to an agent immediately.
- **Agents** create-or-claim (same contract as `/api/me/tasks`), and may pass
  `existingTaskPageId` to claim a specific open task.

Duplicate gate: if similar open tasks exist you get
`409 {"error":"similar_tasks_exist","candidates":[…]}`. Inspect the
candidates, then either re-POST with `"force": true` or drop the request.

Success: `201 { "ok": true, "action": "created", "task": { "id", "title", "url" }, "status": "Proposed" }`.

### `POST /tasks/:id/approve` — scope `tasks:approve`

Move a `Proposed` task to `Backlog` and let the orchestrator route it.
`:id` is the task's Notion page id. Returns `{ "ok": true }`.

### `POST /tasks/:id/dismiss` — scope `tasks:approve`

Archive a proposal (Notion trash). Returns `{ "ok": true }`.

### `GET /events` — scope `read`

Live [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events)
stream of operational events:

```
event: run.started
data: {"id":"…","agentId":"…", …}
```

Event types: `run.started`, `run.finished`, `queue.updated`,
`mention.detected`, `agent.registered`, `agent.updated`, `agent.deleted`,
`app.created`, `app.updated`, `app.deleted`.

```bash
curl -N -H "Authorization: Bearer $KEY" {{NORC_URL}}/api/ext/events
```

In n8n, poll `GET /dashboard` instead, or point an SSE trigger node at this URL.

---

## Errors

| Status | Meaning |
|---|---|
| `401 unauthorized` | Missing, unknown, malformed, or revoked credential |
| `403 forbidden` | Credential lacks the required scope |
| `404 project_not_found` | Unknown project — the response includes the full `projects` roster |
| `409 similar_tasks_exist` | Duplicate gate fired — candidates included |
| `502 notion_error` | Upstream Notion API failure (safe to retry) |
| `503 notion_not_active` / `no_tasks_db` | The Notion workspace isn't connected/provisioned yet |

---

## Good citizenship

- Treat the key like a password: server-side only, rotate on any suspicion.
- Prefer `Proposed` tasks (the default) unless the flow is fully trusted —
  human triage is cheap and catches automation mistakes.
- Don't blind-`force` through the duplicate gate; surface candidates to a
  human or dedupe on your side first.
- The access log records every call your key makes — check the dashboard's
  Apps section when debugging.
