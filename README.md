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
Internet ──▶ nginx :3000 ──/api/, /webhooks/──▶ norc server :3001 ──▶ SQLite (/data volume)
                      └────── / ──▶ dashboard SPA
```

Port 3000 (nginx) is the **single public entry point** — it serves the dashboard and proxies API, OAuth, and webhook traffic to the server. The server itself binds to localhost only. No external database: state lives in one SQLite file on a Docker volume.

---

## Quick start (any server with Docker)

### 1. Clone & configure

```bash
git clone https://github.com/gregoirecambon/norc.git
cd norc
cp .env.example .env
nano .env
```

The `.env` is documented inline. The essentials:

| Variable | Required | Purpose |
|---|---|---|
| `NORC_PUBLIC_URL` | **yes** | The public URL of your install (your domain/tunnel pointing at port 3000). Drives OAuth redirects, invite links, and webhooks. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | one provider | Enables "Continue with Google" |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | one provider | Enables "Continue with GitHub" |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | no | Invite emails (env fallback — easier: configure from **Settings → Email** in the UI). Without SMTP, you get copyable invite links instead. |
| `GITHUB_TOKEN` | no | Higher rate limit for the update checker |
| `COOKIE_SECURE` | no | Set `0` for plain-http LAN installs |

### 2. Get a public HTTPS URL

Notion webhooks and OAuth both need it. Point it at port **3000**:

- **Own domain (recommended for production):** put Caddy / nginx / Traefik in front of `http://localhost:3000` and set `NORC_PUBLIC_URL=https://norc.yourdomain.com`.
- **Cloudflare Tunnel:** `cloudflared tunnel --url http://localhost:3000` → copy the `https://….trycloudflare.com` URL.
- **ngrok:** `ngrok http 3000`.

> `NORC_PUBLIC_URL` must match what the browser actually uses — if it's wrong, OAuth redirects and secure cookies break.

### 3. Create an OAuth app (sign-in)

Pick at least one:

- **Google** — [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) → Create OAuth client ID (Web application)
  - Authorized redirect URI: `<NORC_PUBLIC_URL>/api/auth/google/callback`
- **GitHub** — [github.com/settings/developers](https://github.com/settings/developers) → New OAuth App
  - Authorization callback URL: `<NORC_PUBLIC_URL>/api/auth/github/callback`

Paste the client ID + secret into `.env`.

### 4. Launch

```bash
docker compose up -d --build
```

Open `NORC_PUBLIC_URL` (or `http://localhost:3000`) and sign in.
**The first account to sign in becomes the owner.** Every later sign-in must be invited first.

---

## Team & roles

Invite people from **Team** in the sidebar — by email or by sharing the generated invite link. Invites expire after 7 days; the invitee signs in with the OAuth account matching the invited email.

To enable email delivery, open **Settings → Email** and enter your SMTP provider (host, port, user, app password) — there's a *Send test email to me* button to verify before saving. Without it, every invite still produces a copyable link.

| | Owner | Admin | Member |
|---|---|---|---|
| Use the full dashboard | ✓ | ✓ | ✓ |
| Invite / remove members | ✓ | ✓ | |
| Invite / remove admins | ✓ | | |
| Change roles | ✓ | | |

There is exactly one owner (the first account); the owner can't be demoted or removed.

**Locked out?** (lost access to your OAuth account) — break-glass from the server:

```bash
docker compose exec server node -e "
  const db = require('better-sqlite3')('/data/norc.db');
  db.prepare(\"UPDATE users SET role='owner' WHERE email=?\").run('you@example.com');"
```

---

## Connecting agents

Open **Settings → Connect an Agent** and paste the generated prompt into your agent's `CLAUDE.md` / system prompt. The agent self-registers against `NORC_PUBLIC_URL`.

Agent traffic authenticates with its own tokens (registration token, agent secret, per-run tokens) — it is **not** affected by dashboard sign-in. The dashboard session only protects what humans see.

---

## Updating

The sidebar shows **“Update available →”** (bottom-left) whenever a newer release is published on GitHub. To update:

```bash
git pull && docker compose up -d --build
```

Database migrations run automatically on boot. Releases are tagged `vX.Y.Z` (matching `server/package.json`).

---

## Data & backups

All state lives in one SQLite file on the `norc-data` volume (`/data/norc.db`). To back up:

```bash
docker compose exec server sh -c "sqlite3 /data/norc.db '.backup /data/backup.db'" \
  && docker compose cp server:/data/backup.db ./norc-backup-$(date +%F).db
```

`docker compose down` keeps the volume; only `docker compose down -v` deletes data.

---

## Useful commands

```bash
docker compose logs -f server     # engine logs
docker compose restart server     # restart after a .env change
docker compose up -d --build      # rebuild + update
curl https://your-url/api/health  # reachability check
```

## Troubleshooting

**“This account isn't invited”** — only the first-ever account joins automatically; everyone else needs an invite from Team. The invited email must exactly match the verified primary email of the OAuth account.

**OAuth error / redirect mismatch** — the redirect URI registered with Google/GitHub must be exactly `<NORC_PUBLIC_URL>/api/auth/<provider>/callback` (scheme, host, and port included).

**Login loops back to the sign-in page** — you're probably serving over plain http while cookies are marked Secure. Set `COOKIE_SECURE=0` in `.env` (LAN installs), or serve over https.

**Webhook returns 405 or is unreachable** — confirm your reverse proxy / tunnel points to port **3000** (nginx), not 3001. Test reachability: `curl https://your-url/api/health`.

**Invite emails not arriving** — check `docker compose logs -f server` for SMTP errors; meanwhile every invite also produces a copyable link in the Team page.

---

## Local development

```bash
pnpm install
pnpm dev          # server :3001 + Vite UI :3000 (proxies /api)
```

- Set `NORC_PUBLIC_URL=http://localhost:3000` in `.env` — the **UI** origin, since OAuth callbacks travel through the Vite proxy.
- Register a second pair of OAuth redirect URIs for `http://localhost:3000/api/auth/<provider>/callback`.
- The first sign-in on a fresh `server/norc.db` becomes the owner. Delete the file to start over.
