# NORC — Notion Orchestration for AI Agents

Mention `@Claude Code Agent` anywhere in Notion. NORC assembles context from the linked project and KPIs, dispatches the work to your agent, and writes the result back — while you sleep.

---

## How it works

```
You type "@Claude Code Agent" in a Notion comment or task
    │
    ▼  Notion sends a webhook to NORC
    ▼
NORC detects the @mention → fetches the task + project context from Notion
    │
    ▼  Dispatches to Claude Code with full context + callback URL
    ▼  Agent runs, calls back when done
    ▼
NORC writes the result back to Notion as a comment
```

**Architecture:**

```
Internet → nginx :3000 ──/api/, /webhooks/──▶ norc engine :3001
                    └──/dashboard──▶ static SPA
norc engine ──────────────────────────────────▶ Redis
```

Port 3000 (nginx) is the single public entry point — it serves the dashboard and proxies API and webhook traffic to the engine on port 3001.

---

## Setup (fresh Ubuntu 22.04+)

### 1. Install Docker + Node.js

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Clone NORC

```bash
git clone https://github.com/gregoirecambon/norc.git
cd norc
```

### 3. Set your public URL

Notion needs a public HTTPS URL to deliver webhooks. Configure it in `.env` before running the wizard.

```bash
cp .env.example .env
nano .env   # set NORC_PUBLIC_URL
```

**Option A — Cloudflare Tunnel (recommended, free, no account needed):**
```bash
curl -L https://pkg.cloudflare.com/cloudflared/deb/pool/main/c/cloudflared/cloudflared_linux_amd64.deb -o cf.deb
sudo dpkg -i cf.deb
cloudflared tunnel --url http://localhost:3000
# → copy the https://xxxx.trycloudflare.com URL into NORC_PUBLIC_URL
```

**Option B — ngrok:**
```bash
ngrok http 3000
# → copy the https://xxxx.ngrok.io URL into NORC_PUBLIC_URL
```

**Option C — Own domain:**
Point your reverse proxy (nginx, Caddy, etc.) to `http://localhost:3000` and set `NORC_PUBLIC_URL` to your domain.

### 4. Install the CLI + run the wizard

```bash
sudo npm install -g .
norc init
```

`norc init` is a resumable step-by-step wizard that:
- Checks dependencies
- Starts Docker (Redis + engine + dashboard)
- Creates the 4 Notion databases (Org, Tasks, Projects, Pipeline Config)
- Handles Notion webhook verification
- Registers your first agent

Run it from the cloned `norc/` directory. Press `Ctrl+C` at any time to pause — re-run `norc init` to resume.

---

## CLI reference

```bash
norc init                        # Setup wizard (run once, resumable)
norc agent add <name>            # Register a new agent
norc agent list                  # List registered agents
norc agent test <name>           # Send a test task to an agent
norc run <notion-page-url>       # Manually trigger an agent on a Notion page
norc logs [--agent <name>]       # Tail the live log stream
norc status                      # Show running jobs and agent statuses
norc doctor                      # Check all config and connectivity
```

---

## Useful commands

```bash
# View engine logs
docker compose logs -f norc

# Restart after a config change
docker compose restart norc

# Upgrade NORC
git pull && docker compose up -d --build

# Reinstall the CLI after a code change
sudo npm install -g .
```

---

## Troubleshooting

**Webhook returns 405 or is unreachable**
- Confirm your reverse proxy / tunnel points to port **3000** (nginx), not 3001
- Test reachability: `curl https://your-url/health`
- Run `norc doctor`

**`norc init` fails at "Creating NORC databases"**
- Share the Notion page with your integration first: open the page → `···` → Connections
- Verify your API key starts with `secret_` or `ntn_`

**Agent not responding**
- Verify Claude Code CLI is installed: `claude --version`
- Run `norc agent test claude-code` to send a test dispatch
- Check logs: `norc logs` or `docker compose logs -f norc`

**`norc init` permission error on `~/.norc/`**
```bash
sudo chown -R $USER:$USER ~/.norc
```
