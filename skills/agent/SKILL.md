# NORC Agent Skill (v{{VERSION}})

This document is the durable protocol for participating in NORC orchestration.
Download it once when you join, keep it where your runtime loads instructions
(e.g. `~/.norc/skills/norc.md`, your `CLAUDE.md`, or `AGENTS.md`), and refresh it
when NORC tells you a new version is available (or re-fetch from
`{{NORC_URL}}/api/skill`).

## What NORC is

NORC connects a Notion workspace to you. When someone @mentions you in Notion, or
assigns you a task, NORC assembles the relevant context and sends you a task
prompt. You do the work and report back through the **NORC Agent API**. NORC then
writes your result onto the right Notion page.

## How a task arrives

NORC sends a prompt with these sections (some may be absent):

- **SYSTEM** — your persona + this orchestration behaviour.
- **[PAGE]** — for a free page: its title + link, and whether you've been here
  before. Fetch the full body with `GET <api_base>/page` if you need more.
- **[STRATEGIC CONTEXT]** — company vision / values / strategy (only for
  `strategic`-clearance agents). Background to align your work; rarely the task.
- **[CONTEXT — level: …]** — the project Objective / KPIs / Docs (when relevant).
- **[TASK]** — the task name, status, success criteria, prior output.
- **[COMMENTED-ON TEXT]** — the exact text a comment is attached to (inline
  comments) — i.e. what the human is reacting to.
- **[CONVERSATION SO FAR]** — earlier messages in the Notion thread.
- **[REQUEST]** — what you are being asked to do right now.
- **[NORC RUN]** — the run metadata you need to report back:

  ```
  run_id: <id>
  notion_page_id: <page id>          # for a task, this IS the task id
  reply_discussion_id: <id>          # present only when triggered by a comment
  api_base: {{NORC_URL}}/api/runs/<token>
  ```

  The token in `api_base` authorizes this one run — no other auth header is
  needed. Treat it as a secret. When `reply_discussion_id` is present, the trigger
  was a comment on a specific piece of text — reply there (see below) so your
  answer lands on that text rather than as a loose page comment.

## How to report back

You have two paths:

**1. If you can make HTTP requests (preferred):** call the NORC Agent API at the
`api_base` from `[NORC RUN]`. All writes target this run's page automatically;
add `{"pageId":"<id>"}` to target another page you can access.

```bash
# Reply in the Notion thread (page-level)
curl -s -X POST <api_base>/comment  -H 'Content-Type: application/json' \
  -d '{"text":"Here is my answer…"}'

# Reply ON the precise text (when reply_discussion_id was provided)
curl -s -X POST <api_base>/comment  -H 'Content-Type: application/json' \
  -d '{"text":"Here is my answer…","discussionId":"<reply_discussion_id>"}'

# Fetch the full page (title, link, body as markdown) when you need more context
curl -s <api_base>/page          # or <api_base>/page?pageId=<id> for another page
                                 # ?depth=1..5 controls how deep nested blocks are read

# Pull the structured context NORC assembled for this run (JSON: task, project,
# company, related, body, contextLevel) — handy if you'd rather not parse the prompt
curl -s <api_base>/context

# Append content into the page body (Markdown → Notion blocks)
curl -s -X POST <api_base>/blocks   -H 'Content-Type: application/json' \
  -d '{"markdown":"## Findings\n- point one\n- point two"}'

# Update the task (task runs only)
curl -s -X POST <api_base>/status   -H 'Content-Type: application/json' \
  -d '{"status":"Done","agentOutput":"short summary"}'

# Finish and free yourself (do this last)
curl -s -X POST <api_base>/complete -H 'Content-Type: application/json' \
  -d '{"status":"done","summary":"what I did"}'
```

### Going deeper (strategic agents)

If you are a `strategic`-clearance agent and your operator has enabled open
search, you can explore the workspace beyond the injected context:

```bash
# Full-text search across the workspace
curl -s '<api_base>/search?q=Q3%20revenue%20plan'

# Structured query of a specific database (filter/sorts are Notion's API shapes)
curl -s -X POST <api_base>/query -H 'Content-Type: application/json' \
  -d '{"databaseId":"<db id>","pageSize":25}'
```

These return `403` if you are not a strategic agent or open search is disabled.

Decide the action by intent — especially on a non-task page:

- **Asked to produce content** (write/draft/create a doc, section, summary…) →
  `/blocks` to put it *into the page*. Don't paste long content into a comment.
- **Asked a question / for feedback** → `/comment`. If `reply_discussion_id` is
  set, include it so the reply lands on the exact text; otherwise it's page-level.
- **Finished a task** → `/status` and/or `/complete`.

**Always call `/complete` when you are done** so NORC marks the run finished and
frees you.

**2. If you cannot make HTTP requests:** simply return your answer as your normal
text output. NORC will post it as a comment on the page for you.

## Delegating to another agent

The `[AVAILABLE AGENTS]` section lists peers. To hand off, mention the agent by
name in your reply; NORC routing for delegation is expanding over time.

## Staying current

Your NORC skill has a version. When NORC notifies you (over your gateway, or you
notice a newer version at `{{NORC_URL}}/api/skill/version`), re-fetch
`{{NORC_URL}}/api/skill` and replace your local copy.
