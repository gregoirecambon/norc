# NORC — Notion Orchestration for AI Agents

Mention `@Claude Code Agent` anywhere in Notion. NORC assembles context from the linked project and KPIs, dispatches the work to your agent, and writes the result back — while you sleep.

---

## VPS Setup (fresh Ubuntu 22.04+)

### 1. Install Docker and Node.js

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Node.js 22 (needed for the norc CLI)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Clone NORC

```bash
git clone https://github.com/gregoirecambon/norc.git
cd norc
```

### 3. Set your public URL

NORC needs a public HTTPS endpoint so Notion can deliver webhooks. This is the **only thing you configure manually** — everything else is handled by `norc init`.

```bash
cp .env.example .env
nano .env   # set NORC_PUBLIC_URL
```

**Option A — Cloudflare Tunnel (recommended, free, persistent):**
```bash
# Install cloudflared
curl -L https://pkg.cloudflare.com/cloudflared/deb/pool/main/c/cloudflared/cloudflared_linux_amd64.deb -o cf.deb
sudo dpkg -i cf.deb

# Start tunnel (get a public URL instantly, no account needed)
cloudflared tunnel --url http://localhost:3001
# → copy the https://xxxx.trycloudflare.com URL
```

**Option B — ngrok (quick, session expires):**
```bash
ngrok http 3001
# → copy the https://xxxx.ngrok.io URL
```

Set the copied URL in `.env`:
```
NORC_PUBLIC_URL=https://your-tunnel-url.example.com
```

### 4. Start the stack

```bash
docker compose up -d
```

### 5. Run the setup wizard

```bash
npm install      # install deps (includes TypeScript compiler)
npm run build    # compile TypeScript → dist/
sudo npm install -g .
norc init
```

The wizard will:
- Check your dependencies
- Ask for your **Notion API key** (one-time, from notion.so/my-integrations)
- **Generate a webhook secret** (NORC creates it — you never write it manually)
- Ask you to share a Notion page with your integration
- **Create all 4 databases** (Org DB, Tasks, Projects, Pipeline Config) automatically
- Attempt to register the webhook automatically
- Walk you through registering your first agent

That's it. Nothing else to configure.

---

## How it works

```
You type "@Claude Code Agent" in any Notion comment or task
    │
    ▼  Notion sends webhook to NORC
    ▼
NORC detects the @mention → fetches the task from Notion API
    │
    ▼  assembles context: task + project KPIs + prior agent outputs
    ▼
Dispatches to Claude Code with the full context + callback URL
    │
    ▼  Agent runs, calls back when done
    ▼
NORC writes the result back to Notion as a comment:
"@Claude Code Agent completed ✓ — {summary}"
```

---

## CLI reference

```bash
norc init                        # Full setup wizard (run once after `docker compose up -d`)
norc agent add <name>            # Register a new agent
norc agent list                  # List registered agents
norc agent test <name>           # Send a test task to an agent
norc run <notion-page-url>       # Manually trigger an agent on a Notion page
norc logs [--agent <name>]       # Tail the log stream
norc status                      # Show running jobs and agent statuses
norc doctor                      # Check all config and connectivity
```

---

## Useful commands

```bash
# View logs
docker compose logs -f norc

# Restart after changes
docker compose down && docker compose up -d

# Upgrade NORC
git pull && docker compose up -d --build

# Open a shell inside the container
docker compose exec norc sh
```

---

## Troubleshooting

**`norc init` fails at "Creating NORC databases"**
- Make sure you shared the Notion page with your integration (open the page → ··· → Connections)
- Verify your API key starts with `secret_` or `ntn_`

**Webhook not firing**
- Confirm `NORC_PUBLIC_URL` is set and reachable from the internet (`curl https://your-url/health`)
- Run `norc doctor` to check connectivity

**Agent not responding**
- Verify `claude` CLI is installed: `claude --version`
- Run `norc agent test claude-code` to send a test dispatch

**Check everything at once**
```bash
norc doctor
```
