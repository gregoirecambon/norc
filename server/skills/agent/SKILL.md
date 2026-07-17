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
- **[PROJECT CONTENT]** — the linked project page's actual written body (where
  the real material often lives when the project's properties are thin).
- **[PROJECT RESOURCES]** — the project's sub-pages / sub-databases, each with its
  `pageId`. Pull any in full with `GET <api_base>/page?pageId=<id>` — this is how
  you open a doc the prompt only *names* (e.g. an ONBOARDING sub-page).
- **[RESOURCE: <title>]** — a sub-page NORC pre-fetched for you because the request
  named it; its body is already inline (fetch deeper with `?pageId=…&depth=5`).
- **[RELATED]** — short snippets of the project's linked docs / knowledge /
  sub-pages, each with its `pageId`. Fetch any in full with
  `GET <api_base>/page?pageId=<id>`.
- **[TASK]** — the task name, status, success criteria, prior output.
- **[DEPENDENCIES]** — the results handed off from the task(s) this one depends
  on. Per predecessor: its `summary`, its full page `output` (text and inline
  image/file URLs, in order), and a `files:` list of artifacts (each `→ <url>`).
  **Build directly on these** — they are why this task was unblocked. The URLs are
  fetchable (`curl`) and embeddable, but Notion links are short-lived, so use them
  promptly or re-fetch a fresh one via `GET <api_base>/page?pageId=<id>`.
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

# Find a project resource by NAME — when the prompt mentions a doc but you don't
# have (or lost) its pageId, or a /page fetch failed. Project-scoped; works for
# every agent. Returns {found:true,title,pageId,url,markdown}, or
# {found:false,available:[{title,pageId}…]} so you can pick.
curl -s '<api_base>/resource?name=Onboarding'

# Still stuck? Ask NORC. It searches the WHOLE connected workspace with its own
# access and answers from what it finds → {answer, sources:[{title,pageId,url}]}.
curl -s -X POST <api_base>/assist -H 'Content-Type: application/json' \
  -d '{"question":"How many steps is the onboarding and what are they?"}'

# Pull the structured context NORC assembled for this run (JSON: task, project,
# company, related, dependencies, projectResources, body, projectBody, contextLevel)
# — handy if you'd rather not parse the prompt. `dependencies` is the hand-off from
# the tasks this one depends on (each with summary, body, and an artifacts list);
# `projectResources` lists every sub-page's pageId; `projectBody` is the linked
# project page's full written body.
curl -s <api_base>/context

# Append content into the page body (Markdown → Notion blocks)
curl -s -X POST <api_base>/blocks   -H 'Content-Type: application/json' \
  -d '{"markdown":"## Findings\n- point one\n- point two"}'

# Attach a RESULT FILE (image / document) to this task in Notion — so a dependent
# task can use it. Your file lives on YOUR machine, so ship the bytes base64; NORC
# uploads it to Notion and attaches it as an image/file block on the task page.
# The caption is what the next agent reads to know what it is. Limit 20 MB.
# It then appears in that dependent task's [DEPENDENCIES] → files: list.
curl -s -X POST <api_base>/artifact -H 'Content-Type: application/json' \
  -d "{\"filename\":\"hero-shot.png\",\"caption\":\"Product hero on white bg, 2048px\",
       \"contentBase64\":\"$(base64 < /path/to/hero-shot.png | tr -d '\n')\"}"

# HTML is special: send a self-contained .html file and NORC attaches it as a
# native Notion HTML block — Notion renders it interactively in a sandboxed iframe
# (like the app's /html command), no external host needed. The sandbox blocks
# outbound network calls, so inline all CSS/JS/data — external URLs won't load.
# Perfect for dashboards/reports (e.g. an /app-checkup checkup.html).
curl -s -X POST <api_base>/artifact -H 'Content-Type: application/json' \
  -d "{\"filename\":\"checkup.html\",\"caption\":\"MemoGo App Checkup — 2026-07-16\",
       \"contentBase64\":\"$(base64 < /path/to/checkup.html | tr -d '\n')\"}"

# Update the task (task runs only)
curl -s -X POST <api_base>/status   -H 'Content-Type: application/json' \
  -d '{"status":"Done","agentOutput":"short summary"}'

# Finish and free yourself (do this last). If your runtime reports token usage
# (e.g. Claude Code's total input+output tokens), include it as "tokensUsed" —
# it powers the operator's consumption stats. Omit it if you don't know it.
curl -s -X POST <api_base>/complete -H 'Content-Type: application/json' \
  -d '{"status":"done","summary":"what I did","tokensUsed":123456}'

# Genuinely stuck — you need information only a human can give. Do NOT report
# "done" with an "I couldn't find it" message; report BLOCKED instead. NORC sets
# the task to Blocked, @mentions the owner with what you need, and never marks it
# Done. Use this only after you've actually dug (see "Before you give up" below).
curl -s -X POST <api_base>/complete -H 'Content-Type: application/json' \
  -d '{"status":"blocked","summary":"What I tried, and exactly what I need from a human to proceed"}'

# See your teammates — the roster of AI agents from the Notion Org DB, each with its
# specialty, capabilities, technology, context level and bio. Use it to find who can
# do something you can't, then hand it off with /propose-tasks (see "Delegating" below).
curl -s <api_base>/agents
# → {"agents":[{"name":"Designer","specialty":"Brand & UI","capabilities":"design",
#     "technology":"Claude Code","contextLevel":"project","status":"Available","description":"…"}]}

# Propose follow-up tasks → NORC creates them (Backlog) and triages each
# (auto-routes to the best-fit agent by specialty/capabilities when confident, else
# asks a human). Great for a planning/strategy agent that ends with "we should do
# X, Y, Z" — or to hand off a part of your own task you can't do (see "Delegating").
# To SEQUENCE the plan, add "dependsOn": indices of EARLIER tasks in the same
# batch — those tasks are created on hold and start automatically when their
# predecessors are Done (here, task 2 waits for tasks 0 and 1).
curl -s -X POST <api_base>/propose-tasks -H 'Content-Type: application/json' \
  -d '{"tasks":[{"title":"Draft Q3 pricing","description":"…","kpis":"+10% conversion"},
               {"title":"Competitive scan","description":"…"},
               {"title":"Final pricing proposal","description":"…","dependsOn":[0,1]}]}'
```

## Talking in Slack

When the NORC install is connected to Slack, you can post into Slack channels
through the run API — the message appears under **your own name**, sent by the
Norc app. Use it when the task asks for a brief/update/announcement in Slack,
or when the project is bound to a channel.

```bash
# Post to a Slack channel as yourself. threadTs is optional (reply in-thread).
curl -s -X POST <api_base>/slack -H 'Content-Type: application/json' \
  -d '{"channel":"C0123456789","text":"Pricing brief: …"}'
```

`channel` accepts a channel id in any form it may appear in your context —
`C0123456789`, `#C0123456789`, `<#C0123456789|app-lutai>` — or the exact
channel *name* (`app-lutai`). Prefer the bare id when you have it.

How to find the channel id, in order of preference:

1. The `Slack channel: C…` line in your `[CONTEXT]` block — that's the channel
   bound to this run's project.
2. `GET <api_base>/context` → `project.slackChannelId`.
3. A channel id written in the task body itself (e.g. "post the summary to
   C0123456789").

### Sending files (images, PDFs, …) to Slack

Your files live on YOUR machine — NORC can't read your paths. Ship the bytes
base64-encoded and NORC uploads them into the channel. Images (png/jpg/gif)
render inline in a message posted under YOUR name and avatar; other file
types are shared by the Norc app with your `text` as the comment. Limit
10 MB per file.

```bash
curl -s -X POST <api_base>/slack-file -H 'Content-Type: application/json' \
  -d "{\"channel\":\"C0123456789\",\"filename\":\"contact-sheet.png\",
       \"text\":\"ASO contact sheet — 7 panels, all 1242×2688\",
       \"contentBase64\":\"$(base64 < /path/to/contact-sheet.png | tr -d '\n')\"}"
```

A `403 missing_scope` means this install's Slack app can't upload files yet —
post a text summary instead and mention the file couldn't be attached. Never
paste base64 or raw file contents into a normal text message.

Rules: NORC joins **public** channels by itself when needed, so just post.
**Private** channels can't be self-joined (Slack platform rule) — a
`403 not_in_channel` means a member must `/invite @Norc` there: relay that to
the human, don't retry. `503` means this install has no Slack connection:
report your result in Notion instead and note that Slack was unavailable.
Don't post secrets or raw API output; write a short, channel-appropriate
message. When a task's project has a bound channel, NORC already posts a
completion summary there automatically — only post yourself when the task
explicitly asks for Slack content beyond that summary.

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

**Before you give up:** if the context looks thin, DIG before reporting blocked.
Work the resource ladder in order — you can almost always get the material yourself:

1. Read any sub-page listed in `[PROJECT RESOURCES]` / `[RELATED]` by its `pageId`:
   `GET <api_base>/page?pageId=<id>` (`?depth=1..5` for nested content).
2. Know the doc by name but not its id (or a fetch failed)?
   `GET <api_base>/resource?name=<title>` — NORC finds it within the project.
3. Still can't get it? `POST <api_base>/assist {"question":"…"}` — NORC searches the
   whole connected workspace and answers from what it finds.

Report `blocked` only after that ladder comes up empty AND the missing information
is something **only a human can supply** (e.g. a private repo, an unconnected page,
a decision) — not because the first prompt looked thin. NORC also auto-detects
give-up replies, so being honest about a real block is always safe.

**Always call `/complete` when you are done** so NORC marks the run finished and
frees you. If your runtime exposes how many tokens the run consumed, pass the
total as `tokensUsed` (an integer) — best-effort, but it makes the operator's
usage statistics real.

**2. If you cannot make HTTP requests:** simply return your answer as your normal
text output. NORC will post it as a comment on the page for you.

## Out-of-band work — the CORE RULE

You also talk to humans outside NORC (Slack, chat, email, …). **Never silently
do project work that was asked out-of-band.** Every piece of real work must be
a NORC task — otherwise the team can't see it, and you may duplicate work that
is already running. Questions and pure conversation are fine to answer
directly; this rule is for actual WORK (produce, build, fix, write, analyse…).

These calls use the `agentSecret` you saved at registration
(`Authorization: Bearer <agentSecret>`) — NOT a run token.

When a human asks you for project work outside Notion:

**1. Check** for an existing open task on that project:

```bash
curl -s '{{NORC_URL}}/api/me/tasks?project=Site%20v2&q=login%20bug' \
  -H 'Authorization: Bearer <agentSecret>'
```

**2. Create or claim** the task. NORC re-checks for duplicates server-side, so
this step is safe even if you skipped the check:

```bash
curl -s -X POST {{NORC_URL}}/api/me/tasks \
  -H 'Authorization: Bearer <agentSecret>' -H 'Content-Type: application/json' \
  -d '{"title":"Fix login bug","description":"<the user'\''s exact ask>","project":"Site v2","source":"slack"}'
```

**3. Act on the response:**

- **`409 similar_tasks_exist`** → an open task already looks like the same
  work. WARN the user in your channel, show them the `candidates`, and let
  THEM decide — never decide alone. Then re-POST with
  `{"existingTaskPageId":"<id>"}` to claim the existing task, or
  `{"force":true}` to create anyway.
- **`mode:"dispatched"`** → the task is yours and the response carries a
  `run` block (`api_base`). Do the work NOW, in this conversation, and report
  exactly like a normal run: `/comment`, `/blocks`, `/status` — and ALWAYS
  finish with `POST <api_base>/complete`, promptly. An unreported run times
  out and the task gets reassigned.
- **`mode:"queued"`** → you are busy with other NORC work. The task was
  created (or claimed) and queued at the FRONT of your queue — tell the user
  it runs next. NORC will send you the original request the moment your
  current run finishes. Do NOT start the work now.

NORC guarantees no double-run: the task page it creates for you is webhook-loop
protected, so you will never receive a second dispatch for work you already
started this way.

## Delegating to another agent

Do your task yourself. But if it genuinely needs a skill, tool, or capability you
**don't have** — or part of it clearly belongs to a different specialist — hand
that part off instead of forcing a bad result or silently dropping it. Do this
**only when you're actually stuck**, not to offload work you can do.

**1. Find the right teammate.** The `[OTHER AGENTS]` block names your peers. Pull
their full profiles — specialty, capabilities, technology, and bio — straight from
the Notion Org DB, and match the missing skill to an agent's capabilities:

```bash
curl -s <api_base>/agents
# → {"agents":[{"name":"Designer","specialty":"Brand & UI","capabilities":"design",
#     "technology":"Claude Code","contextLevel":"project","status":"Available","description":"…bio…"}]}
```

**2. Hand the work off by proposing a task.** You don't message the agent directly —
you create the work and NORC routes it. NORC triages each proposed task and
auto-routes it to the agent whose specialty/capabilities fit, so **write the
description so the needed skills are obvious** (e.g. "needs a designer: …"):

```bash
curl -s -X POST <api_base>/propose-tasks -H 'Content-Type: application/json' \
  -d '{"tasks":[{"title":"Design the hero image","description":"Need a designer — 2048px hero on white bg","kpis":"on-brand, 2048px"}]}'
```

**3. Order it relative to your own work with `dependsOn` ("blocked by").**
`dependsOn` is a list of indices of EARLIER tasks **in the same batch** that a task
is blocked by: it's created on hold and starts automatically once those are Done.

- **Follow-up that comes AFTER your work** → finish your task, then propose the
  follow-up(s). Chain a multi-step plan in one batch: task `2` with `dependsOn:[0,1]`
  starts only once tasks `0` and `1` complete.
- **A prerequisite you can't produce yourself** → propose it for the teammate who
  can, do as much of your own task as you can without it, and report your result.
  If you genuinely **cannot proceed at all** without it, report `blocked` (see
  "Before you give up") so the owner sees the gap — don't report "done".

Either way the hand-off becomes a normal NORC task: the next agent picks it up with
full context, your proposed `description`, and any files you attached via `/artifact`.

## Staying current

Your NORC skill has a version. When NORC notifies you (over your gateway, or you
notice a newer version at `{{NORC_URL}}/api/skill/version`), re-fetch
`{{NORC_URL}}/api/skill` and replace your local copy.
