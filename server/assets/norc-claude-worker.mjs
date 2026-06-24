// Generated from @norc/claude-worker — do not edit. Regenerate: pnpm --filter @norc/claude-worker bundle

// src/config.ts
import os from "node:os";
import path from "node:path";
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function strEnv(name) {
  const v = (process.env[name] ?? "").trim();
  return v || null;
}
function loadConfig() {
  const workDir = strEnv("WORK_DIR") ?? path.join(os.tmpdir(), "norc-claude-worker");
  const extraRaw = strEnv("CLAUDE_EXTRA_ARGS");
  return {
    port: intEnv("PORT", 8080),
    sharedSecret: strEnv("NORC_SHARED_SECRET"),
    claudeBin: strEnv("CLAUDE_BIN") ?? "claude",
    workDir,
    defaultCwd: strEnv("DEFAULT_CWD"),
    model: strEnv("CLAUDE_MODEL"),
    extraArgs: extraRaw ? extraRaw.split(/\s+/) : [],
    maxConcurrency: intEnv("MAX_CONCURRENCY", 2),
    jobTimeoutMs: intEnv("JOB_TIMEOUT_MS", 30 * 6e4),
    heartbeatMs: intEnv("HEARTBEAT_MS", 9e4),
    sessionsFile: strEnv("SESSIONS_FILE") ?? path.join(workDir, "sessions.json"),
    norcUrl: strEnv("NORC_URL")?.replace(/\/+$/, "") ?? null,
    registerToken: strEnv("NORC_REGISTER_TOKEN"),
    agentName: strEnv("AGENT_NAME"),
    publicUrl: strEnv("WORKER_PUBLIC_URL")?.replace(/\/+$/, "") ?? null,
    credentialsFile: strEnv("CREDENTIALS_FILE") ?? path.join(workDir, "credentials.json")
  };
}

// src/dispatch.ts
import { mkdirSync as mkdirSync2 } from "node:fs";
import path3 from "node:path";

// src/sessions.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path2 from "node:path";
var SessionStore = class {
  constructor(file) {
    this.file = file;
    try {
      this.data = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      this.data = {};
    }
  }
  data = {};
  get(pageId) {
    return this.data[pageId];
  }
  set(pageId, rec) {
    this.data[pageId] = rec;
    try {
      mkdirSync(path2.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {
    }
  }
};

// src/log.ts
function log(msg) {
  console.log(`[norc-claude-worker ${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}`);
}

// src/norc-client.ts
var NorcRun = class {
  constructor(apiBase) {
    this.apiBase = apiBase;
  }
  async post(endpoint, body) {
    try {
      const res = await fetch(`${this.apiBase}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3e4)
      });
      if (!res.ok) {
        log(`callback ${endpoint} -> HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      log(`callback ${endpoint} failed: ${err instanceof Error ? err.message : "unknown"}`);
      return false;
    }
  }
  /**
   * Liveness ping. POST /status with an empty body does no Notion write but the
   * Agent API middleware bumps the run's progress clock, keeping a long job off
   * NORC's idle-timeout sweep without spamming the task with comments.
   */
  heartbeat() {
    return this.post("status", {});
  }
  comment(text) {
    return this.post("comment", { text });
  }
  status(body) {
    return this.post("status", body);
  }
  artifact(body) {
    return this.post("artifact", body);
  }
  /** Terminal report. NORC posts a visible comment, drives task status, releases dependents. */
  complete(body) {
    return this.post("complete", body);
  }
};

// src/claude.ts
import { spawn } from "node:child_process";
function runClaude(args) {
  return new Promise((resolve) => {
    const cli = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];
    if (args.model) cli.push("--model", args.model);
    if (args.appendSystemPrompt) cli.push("--append-system-prompt", args.appendSystemPrompt);
    if (args.resumeSessionId) cli.push("--resume", args.resumeSessionId);
    cli.push(...args.extraArgs);
    log(`spawn ${args.claudeBin} -p (cwd=${args.cwd}${args.resumeSessionId ? `, resume=${args.resumeSessionId}` : ", new session"})`);
    const child = spawn(args.claudeBin, cli, {
      cwd: args.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, text: "", sessionId: null, error: `Claude Code timed out after ${Math.round(args.timeoutMs / 1e3)}s` });
    }, args.timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => finish({
      ok: false,
      text: "",
      sessionId: null,
      error: `failed to spawn ${args.claudeBin}: ${err.message}`
    }));
    child.on("close", (code) => {
      const parsed = parseClaudeJson(stdout);
      if (parsed) {
        finish({
          ok: !parsed.isError && code === 0,
          text: parsed.text,
          sessionId: parsed.sessionId,
          ...parsed.isError ? { error: parsed.text || "Claude reported an error" } : {}
        });
        return;
      }
      const text = stdout.trim();
      if (code === 0 && text) {
        finish({ ok: true, text, sessionId: null });
        return;
      }
      finish({
        ok: false,
        text,
        sessionId: null,
        error: stderr.trim().split("\n")[0] || `claude exited with code ${code}`
      });
    });
    child.stdin.write(args.prompt);
    child.stdin.end();
  });
}
function parseClaudeJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let obj = null;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("{");
    if (start >= 0) {
      try {
        obj = JSON.parse(trimmed.slice(start));
      } catch {
        obj = null;
      }
    }
  }
  if (!obj) return null;
  const text = typeof obj["result"] === "string" ? obj["result"] : typeof obj["text"] === "string" ? obj["text"] : "";
  const sessionId = typeof obj["session_id"] === "string" ? obj["session_id"] : typeof obj["sessionId"] === "string" ? obj["sessionId"] : null;
  const isError = obj["is_error"] === true || obj["subtype"] === "error_during_execution" || obj["subtype"] === "error_max_turns";
  return { text, sessionId, isError };
}

// src/dispatch.ts
function parseField(prompt, field) {
  const m = prompt.match(new RegExp(`${field}:\\s*(\\S+)`));
  return m ? m[1] : null;
}
var Dispatcher = class {
  constructor(config2) {
    this.config = config2;
    this.store = new SessionStore(config2.sessionsFile);
  }
  store;
  active = 0;
  queue = [];
  /** Accept a dispatch and run it in the background. Returns immediately. */
  accept(payload) {
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const system = typeof payload.system === "string" ? payload.system : "";
    const apiBase = parseField(prompt, "api_base");
    const pageId = parseField(prompt, "notion_page_id");
    if (!apiBase) {
      log("dispatch missing api_base in prompt \u2014 cannot report back, ignoring");
      return;
    }
    void this.runJob({ apiBase, pageId, system, prompt });
  }
  acquire() {
    if (this.active < this.config.maxConcurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(() => {
      this.active++;
      resolve();
    }));
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
  async runJob(job) {
    await this.acquire();
    const run = new NorcRun(job.apiBase);
    const heartbeat = setInterval(() => {
      void run.heartbeat();
    }, this.config.heartbeatMs);
    try {
      const prior = job.pageId ? this.store.get(job.pageId) : void 0;
      const cwd = prior?.cwd ?? this.resolveCwd(job.pageId);
      mkdirSync2(cwd, { recursive: true });
      const result = await runClaude({
        claudeBin: this.config.claudeBin,
        prompt: job.prompt,
        cwd,
        model: this.config.model,
        appendSystemPrompt: job.system || null,
        resumeSessionId: prior?.sessionId ?? null,
        extraArgs: this.config.extraArgs,
        timeoutMs: this.config.jobTimeoutMs
      });
      if (result.sessionId && job.pageId) {
        this.store.set(job.pageId, { sessionId: result.sessionId, cwd, updatedAt: Date.now() });
      }
      if (result.ok) {
        const summary = result.text.trim() || "(Claude Code finished but returned no text.)";
        await run.complete({ status: "done", summary });
        log(`job done (page ${job.pageId ?? "?"}) \u2014 ${summary.length} chars`);
      } else {
        await run.complete({ status: "failed", summary: result.error || "Claude Code failed." });
        log(`job failed (page ${job.pageId ?? "?"}): ${result.error ?? "unknown"}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      await run.complete({ status: "failed", summary: `Worker error: ${msg}` });
      log(`job error: ${msg}`);
    } finally {
      clearInterval(heartbeat);
      this.release();
    }
  }
  resolveCwd(pageId) {
    if (this.config.defaultCwd) return this.config.defaultCwd;
    return path3.join(this.config.workDir, pageId ?? `run-${Date.now()}`);
  }
};

// src/server.ts
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
function secretOk(provided, secret) {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
async function respondChallenge(payload) {
  if (!payload.callbackUrl || !payload.nonce) return;
  try {
    await fetch(payload.callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: payload.nonce }),
      signal: AbortSignal.timeout(8e3)
    });
    log("handshake challenge answered");
  } catch (err) {
    log(`handshake challenge failed: ${err instanceof Error ? err.message : "unknown"}`);
  }
}
function createWorkerServer(opts) {
  const { sharedSecret: sharedSecret2, dispatcher: dispatcher2 } = opts;
  async function handle(req, res) {
    if (req.method === "GET") {
      send(res, 200, { ok: true, service: "norc-claude-worker" });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!secretOk(req.headers["x-norc-secret"], sharedSecret2)) {
      send(res, 401, { error: "unauthorized" });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      send(res, 400, { error: "invalid_json" });
      return;
    }
    switch (payload.type) {
      case "norc_dispatch":
        send(res, 202, { accepted: true, async: true });
        dispatcher2.accept(payload);
        return;
      case "norc_challenge":
        send(res, 200, { ok: true });
        void respondChallenge(payload);
        return;
      case "norc_skill_update":
        send(res, 200, { ok: true });
        return;
      default:
        send(res, 400, { error: "unknown_type", type: payload.type ?? null });
    }
  }
  return http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log(`request error: ${err instanceof Error ? err.message : "unknown"}`);
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
    });
  });
}

// src/register.ts
import { execFileSync } from "node:child_process";
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, mkdirSync as mkdirSync3 } from "node:fs";
import { randomBytes } from "node:crypto";
import os2 from "node:os";
import path4 from "node:path";
function loadCredentials(file) {
  try {
    const c = JSON.parse(readFileSync2(file, "utf8"));
    return c.sharedSecret ? c : null;
  } catch {
    return null;
  }
}
function saveCredentials(file, creds) {
  mkdirSync3(path4.dirname(file), { recursive: true });
  writeFileSync2(file, JSON.stringify(creds, null, 2));
}
function detectWorkerUrl(config2) {
  if (config2.publicUrl) return config2.publicUrl;
  try {
    const out = execFileSync("tailscale", ["ip", "-4"], { timeout: 5e3 }).toString();
    const ip = out.split(/\s+/).map((s) => s.trim()).find((s) => /^100\./.test(s));
    if (ip) return `http://${ip}:${config2.port}/`;
  } catch {
  }
  return `http://${os2.hostname()}:${config2.port}/`;
}
function defaultName() {
  const host = os2.hostname().toLowerCase().split(".")[0] ?? "agent";
  const slug = host.replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "") || "agent";
  return `claude-${slug}`;
}
async function postRegister(norcUrl, token, body) {
  const res = await fetch(`${norcUrl}/api/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15e3)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, status: res.status, error: typeof json["error"] === "string" ? json["error"] : `HTTP ${res.status}` };
  }
  return { ok: true, agentId: String(json["agentId"] ?? ""), agentSecret: String(json["agentSecret"] ?? "") };
}
async function resolveIdentity(config2) {
  const existing = loadCredentials(config2.credentialsFile);
  if (existing) {
    log(`reusing registered identity "${existing.name}" (${config2.credentialsFile})`);
    return { sharedSecret: existing.sharedSecret, selfRegistered: false };
  }
  const canSelfRegister = !!(config2.norcUrl && config2.registerToken);
  if (!canSelfRegister) {
    if (config2.sharedSecret) return { sharedSecret: config2.sharedSecret, selfRegistered: false };
    throw new Error(
      "No identity configured. Either set NORC_URL + NORC_REGISTER_TOKEN to self-register (the copy-paste path), or set NORC_SHARED_SECRET and register the agent manually in the NORC dashboard."
    );
  }
  const sharedSecret2 = config2.sharedSecret ?? randomBytes(32).toString("hex");
  const url = detectWorkerUrl(config2);
  let name = config2.agentName ?? defaultName();
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await postRegister(config2.norcUrl, config2.registerToken, {
      name,
      adapterType: "http",
      adapterConfig: { url, sharedSecret: sharedSecret2 },
      metadata: { kind: "remote-claude-code", host: os2.hostname() }
    });
    if (result.ok) {
      const creds = { agentId: result.agentId, agentSecret: result.agentSecret, sharedSecret: sharedSecret2, url, name };
      saveCredentials(config2.credentialsFile, creds);
      log(`registered with NORC as "${name}" \u2192 ${url}`);
      return { sharedSecret: sharedSecret2, selfRegistered: true };
    }
    if (result.error === "name_taken") {
      name = `${defaultName()}-${randomBytes(2).toString("hex")}`;
      continue;
    }
    throw new Error(`registration failed: ${result.error}. Get a fresh invite from the NORC dashboard.`);
  }
  throw new Error("registration failed: could not find a free agent name after 3 tries.");
}

// src/index.ts
var config = loadConfig();
var dispatcher = new Dispatcher(config);
var { sharedSecret, selfRegistered } = await resolveIdentity(config);
var server = createWorkerServer({ port: config.port, sharedSecret, dispatcher });
server.listen(config.port, () => {
  log(`listening on :${config.port} (claudeBin=${config.claudeBin}, maxConcurrency=${config.maxConcurrency}, workDir=${config.workDir})`);
  if (selfRegistered) log("self-registered with NORC \u2014 should appear connected in the dashboard shortly");
});
