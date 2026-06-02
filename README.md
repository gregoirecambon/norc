# NORC — Notion Orchestration for AI Agents

Mention `@Claude Code Agent` anywhere in Notion. NORC assembles context from the linked project and KPIs, dispatches the work to your agent, and writes the result back — while you sleep.

---

## VPS Setup (fresh Ubuntu 22.04+)

### 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

Verify:
```bash
docker --version
docker compose version
```

### 2. Clone NORC

```bash
git clone https://github.com/gregoirecambon/norc.git
cd norc
```

### 3. Configure environment

```bash
cp .env.example .env
nano .env
```

Fill in these required values:

| Variable | Where to get it |
|---|---|
| `NOTION_API_KEY` | notion.so/my-integrations → New integration → copy Secret |
| `NOTION_WEBHOOK_SECRET` | Any random string ≥ 16 chars (you choose) |
| `NOTION_ORG_DB_ID` | After duplicating the Notion template (step 5) |
| `NOTION_TASKS_DB_ID` | Same |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `NORC_PUBLIC_URL` | Your domain or tunnel URL (step 4) |
| `NORC_WORK_DIR` | Absolute path to the repo your agent will work in |

### 4. Expose the webhook endpoint

NORC needs a public HTTPS URL so Notion can deliver webhooks.

**Option A — Cloudflare Tunnel (recommended, free, persistent)**

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# Authenticate (opens a browser link — copy it to your local machine)
cloudflared tunnel login

# Create a tunnel
cloudflared tunnel create norc
cloudflared tunnel route dns norc norc.yourdomain.com

# Start the tunnel (points to the NORC engine)
cloudflared tunnel run --url http://localhost:3001 norc &
```

Set `NORC_PUBLIC_URL=https://norc.yourdomain.com` in `.env`.

**Option B — ngrok (quick, session expires)**

```bash
npm install -g ngrok
ngrok http 3001
```

Copy the `https://xxxx.ngrok.io` URL → set as `NORC_PUBLIC_URL` in `.env`.

### 5. Duplicate the Notion template

1. Open: **notion.so/templates/norc-workspace**
2. Click **Duplicate** → choose your workspace
3. Open the duplicated workspace
4. Copy each database URL and extract the IDs:
   - Org DB → `NOTION_ORG_DB_ID`
   - Tasks → `NOTION_TASKS_DB_ID`
   - Projects → `NOTION_PROJECTS_DB_ID`
   - Pipeline Config → `NOTION_PIPELINE_CONFIG_DB_ID`

Database ID is the 32-character hex string in the URL:
```
notion.so/YOUR-WORKSPACE/Tasks-abc123def456...?v=...
                                ^^^^^^^^^^^^^^^^^^ this part (no dashes)
```

### 6. Register the Notion webhook

In your Notion integration settings (notion.so/my-integrations → your integration):

1. Go to **Webhooks** → **Add webhook**
2. URL: `https://norc.yourdomain.com/webhooks/notion`
3. Events: select **Page updated**, **Comment created**
4. Select your Tasks database as the scope

### 7. Start the stack

```bash
docker compose up -d
```

Check it's running:
```bash
docker compose ps
curl http://localhost:3001/health
# → {"status":"ok","redis":"ok","ts":"..."}
```

View logs:
```bash
docker compose logs -f norc
```

### 8. Register your first agent

```bash
npm install -g .        # installs the norc CLI globally
norc agent add claude-code
```

The wizard asks for:
- Agent name (e.g. `claude-code`)
- Technology (`Claude Code`)
- API key env var (`ANTHROPIC_API_KEY`)

Then add the skill to your project's `CLAUDE.md`:
```
Skill: ~/.norc/skills/claude-code.md
```

### 9. Test it

In your Notion workspace, open any task and type `@Claude Code Agent` in a comment. Watch the logs:

```bash
norc logs
# or
docker compose logs -f norc
```

The agent should appear in the Live Feed at `http://YOUR_VPS_IP:3000`.

---

## CLI reference

```bash
norc init                        # Full 6-step setup wizard
norc agent add <name>            # Register a new agent
norc agent list                  # List registered agents
norc agent test <name>           # Send a test task
norc run <notion-page-url>       # Manually trigger an agent on a page
norc logs [--agent <name>]       # Tail the log stream
norc status                      # Show running jobs and agent statuses
norc doctor                      # Check all config and connectivity
```

---

## Architecture

```
Notion @mention
    │  webhook (via Cloudflare Tunnel)
    ▼
NORC Engine (:3001)
    ├── Mention detector    — finds agent page IDs in event payload
    ├── Orchestrator (haiku) — classifies intent, detects anomalies
    ├── Context assembler   — task + project KPIs + prior outputs
    ├── BullMQ + Redis      — async job queue, lock renewal, retry
    └── Claude Code adapter — runs claude -p with full context

Agent completes → POST /api/callback/{token}
    │
    ▼
NORC writes back to Notion:
    "@Claude Code Agent completed ✓ — {summary}"
```

---

## Useful commands

```bash
# Restart after config change
docker compose down && docker compose up -d

# Watch all container logs
docker compose logs -f

# Open a shell inside the NORC container
docker compose exec norc sh

# Stop everything
docker compose down

# Upgrade NORC
git pull && docker compose up -d --build
```

---

## Troubleshooting

**Webhook not firing**
- Check `NORC_PUBLIC_URL` matches your Cloudflare Tunnel / ngrok URL exactly
- Verify the Notion webhook is registered: notion.so/my-integrations → your integration → Webhooks
- Run `norc doctor` to confirm connectivity

**Agent not responding**
- Check `ANTHROPIC_API_KEY` is set in `.env`
- Verify `claude` CLI is installed: `claude --version`
- Check `NORC_WORK_DIR` points to a real directory

**Redis connection error**
- Run `docker compose ps` — Redis container should show `healthy`
- Run `docker compose restart redis` if it's stuck

**Notion 401 errors**
- Your `NOTION_API_KEY` may have expired or be scoped incorrectly
- Verify the integration has access to all 4 databases (Org DB, Tasks, Projects, Pipeline Config)
