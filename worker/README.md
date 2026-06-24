# norc-claude-worker

Runs **Claude Code on a VPS/server/laptop** and lets NORC dispatch tasks to it. From NORC's
side the worker is just an agent on the **`http` adapter**: NORC POSTs the task, the worker
runs `claude -p` (fully autonomous, your subscription login), and reports results back
through NORC's Agent API. Long tasks and feedback work because the worker keeps a **Claude
Code session per Notion task** and resumes it on follow-up turns.

```
NORC ──POST {type:'norc_dispatch', system, prompt}──▶ worker ──spawn `claude -p`──▶ Claude Code
  ▲   (prompt carries [NORC RUN]: notion_page_id + api_base=/api/runs/<token>)        │
  └────── POST /api/runs/<token>/{status,comment,complete,artifact} ◀─────────────────┘
```

## Easiest setup (zero-config, over Tailscale)

In NORC: **Agents → Add Agent → Invite Prompt → Remote Claude Code**, copy the prompt, and
run it on the target machine. It boils down to:

```bash
curl -fsSL https://<norc>/api/worker -o ~/.norc-worker.mjs && \
NORC_URL=https://<norc> NORC_REGISTER_TOKEN=<one-time-token> \
  nohup node ~/.norc-worker.mjs > ~/.norc-worker.log 2>&1 &
```

The worker **generates its own secret**, **detects this machine's Tailscale address**, and
**self-registers** with NORC. It appears as a connected agent within ~a minute. Restarts
reuse the saved credentials (`credentials.json`) — the one-time token isn't needed again.

> Works because NORC and the worker are on the same **Tailscale** network: every node has a
> stable `100.x` address reachable across the tailnet, so NORC can reach the worker with no
> port-forwarding or public URL — laptop or VPS alike.

## Prerequisites

- **Node 22+** on the box.
- **Claude Code installed and logged in** as the user running the worker (`claude` on PATH,
  subscription session active — run `claude` once interactively to confirm). The worker
  shells out to that CLI, so it inherits the subscription; no API key.
- The machine on the **same Tailscale network** as NORC.

> ⚠️ The worker runs Claude Code with `--dangerously-skip-permissions` (fully autonomous).
> Treat the box as **dedicated/isolated** — Claude can run arbitrary commands there. The
> dispatch endpoint is gated by the shared secret; the tailnet limits who can reach it.

## Keep it running

Wrap the command in **systemd** or **pm2** so it survives reboots. Example systemd unit:

```ini
[Unit]
Description=norc-claude-worker
After=network-online.target

[Service]
Environment=NORC_URL=https://<norc>
Environment=NORC_REGISTER_TOKEN=<one-time-token>
ExecStart=/usr/bin/node %h/.norc-worker.mjs
Restart=always

[Install]
WantedBy=default.target
```

## Run from source (dev / advanced)

```bash
cd worker
cp .env.example .env     # set NORC_URL + NORC_REGISTER_TOKEN (self-register), or NORC_SHARED_SECRET (manual)
pnpm install
pnpm start               # tsx src/index.ts
pnpm bundle              # regenerate server/assets/norc-claude-worker.mjs (what /api/worker serves)
```

## How feedback / "reopen the session" works

The worker stores `notion_page_id → { sessionId, cwd }` in `sessions.json`. When you comment
on the same task in Notion (or reply in its Slack thread), NORC re-dispatches to this agent
for the same page; the worker runs `claude -p --resume <sessionId>`, continuing with full
prior context.

## Resuming a task's session by hand

Each task is a real Claude Code session, kept on the worker machine (not deleted). The
worker reports the **real Claude session id** to NORC on completion, so the dashboard
session pill shows the id you pass to `claude --resume` (previously it showed NORC's
internal key, which `claude --resume` rejects with "No conversation found").

`claude --resume <id>` is **scoped to the directory the session ran in**, so you must run
it there. The completion comment NORC posts includes the exact command, e.g.:

```bash
cd ~/.norc/<notion-page-id> && claude --resume <session-id>
```

You can also look any session up directly in `~/.norc/sessions.json` (maps Notion page id
→ `{ sessionId, cwd }`). Sessions persist per Claude Code's own retention
(`cleanupPeriodDays`, default 30); the worker never deletes them.

## Notes / limits

- **Long jobs:** the worker pings `POST /status` every `HEARTBEAT_MS` to keep the run off
  NORC's idle-timeout sweep. NORC's absolute **hard cap** (Settings → Operations) still
  applies — raise it for very long jobs.
- **Concurrency:** NORC gates per-agent concurrency; `MAX_CONCURRENCY` is a second cap so a
  raised NORC limit can't oversubscribe the box. Each task gets its own working dir unless
  `DEFAULT_CWD` is set.
- **Manual registration** (no self-register): set `NORC_SHARED_SECRET`, run the worker, then
  add the agent in the dashboard (Manual → Remote Claude Code) with the worker URL + secret.
- All config is via env — see `.env.example`.
