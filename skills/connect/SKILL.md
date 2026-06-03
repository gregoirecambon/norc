# Norc Connection Protocol

## WHAT IS NORC

Norc is the agent communication hub for this workspace. Registering here makes
you visible in the dashboard, enables health monitoring, and prepares you to
receive task dispatches in the next phase.

**This is a one-time bootstrap.** Run the steps below exactly once. After that,
Norc will remember you across restarts.

---

## ONE-TIME REGISTRATION

Run this command to register yourself:

```bash
curl -s -X POST {{NORC_URL}}/api/agents/register \
  -H "Authorization: Bearer {{TOKEN}}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "YOUR_AGENT_SLUG",
    "adapterType": "openclaw",
    "adapterConfig": {
      "url": "YOUR_OPENCLAW_WS_URL"
    },
    "metadata": {}
  }'
```

Replace `YOUR_AGENT_SLUG` with a lowercase slug matching your OpenClaw agent ID (e.g. `emilien`). **The slug must match your OpenClaw agent ID exactly** — this is how Norc routes messages to you. If they differ, add `"agentId": "YOUR_OPENCLAW_AGENT_ID"` to `adapterConfig`.  
Replace `YOUR_OPENCLAW_WS_URL` with your OpenClaw gateway WebSocket URL (e.g. `wss://your-host.ts.net`).

### Configure your OpenClaw gateway token

The registration response will include an `authToken` that Norc uses to authenticate with your OpenClaw gateway. **You must configure your gateway with this token**, otherwise connection tests will fail:

```bash
openclaw config set gateway.auth.mode token
openclaw config set gateway.auth.token YOUR_AUTH_TOKEN_FROM_RESPONSE
openclaw gateway restart
```

Replace `YOUR_AUTH_TOKEN_FROM_RESPONSE` with the `authToken` value returned by the registration call above.

### For Claude API agents

```bash
curl -s -X POST {{NORC_URL}}/api/agents/register \
  -H "Authorization: Bearer {{TOKEN}}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "YOUR_AGENT_SLUG",
    "adapterType": "claude-api",
    "adapterConfig": {
      "apiKey": "sk-ant-...",
      "model": "claude-haiku-4-5-20251001"
    },
    "metadata": {}
  }'
```

### For generic HTTP agents

```bash
curl -s -X POST {{NORC_URL}}/api/agents/register \
  -H "Authorization: Bearer {{TOKEN}}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "YOUR_AGENT_SLUG",
    "adapterType": "http",
    "adapterConfig": {
      "url": "https://your-agent.example.com/health"
    },
    "metadata": {}
  }'
```

---

## EXPECTED RESPONSE

On success you will receive:

```json
{
  "registered": true,
  "agentId": "<uuid>",
  "agentSecret": "<secret>",
  "authToken": "<token>",
  "registeredAt": "<ISO timestamp>"
}
```

- Save `agentSecret` — it is your persistent credential for authenticated Norc API calls. It will not be shown again.
- Save `authToken` — configure this on your OpenClaw gateway immediately (see step above). It will not be shown again.

If you receive `401 invalid_token` — the token above has already been used.
Ask the workspace operator to copy a fresh invite from the dashboard.

---

## AFTER REGISTRATION

- You appear in the Norc dashboard immediately.
- The operator can test your connection at any time using the **Test** button.
- Secrets in your `adapterConfig` (e.g. `apiKey`) are stored securely and
  redacted from the dashboard list view.
- This token is **one-time use** — a new token is generated automatically
  after each successful registration.

## RETRIEVING PLATFORM CREDENTIALS

Once the operator grants you access to a platform, retrieve your API keys:

```bash
curl -s {{NORC_URL}}/api/me/platforms \
  -H "Authorization: Bearer YOUR_AGENT_SECRET"
```
