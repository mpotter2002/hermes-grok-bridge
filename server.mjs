#!/usr/bin/env node
/**
 * hermes-grok-bridge: stdio MCP server that lets a Grok Bot chat talk to a Hermes agent
 * (https://hermes-agent.nousresearch.com) through the Hermes gateway API server.
 *
 * Thin pass-through: replies come back verbatim.
 *  - Bot Chat / non-API sessions: POST /api/sessions/{id}/chat (the `hermes peer dm` door).
 *  - API-created sessions: /v1/runs with session_id (background run, poll/steer/stop).
 *
 * Env:
 *   HERMES_BASE_URL       required, e.g. http://<hermes-host>:8642  (a trailing /v1 is stripped)
 *   HERMES_API_KEY        default-profile API_SERVER_KEY, or
 *   HERMES_API_KEY_FILE   path to a file holding it (default ~/.hermes/api_server_key)
 *   HERMES_PROFILE_KEY_<NAME>  key for a named profile (or file in HERMES_PROFILE_KEY_DIR/<name>)
 *   HERMES_BRIDGE_CONFIG  config path (default ~/.hermes/bridge.json, no secrets)
 *   HERMES_BRIDGE_STATE   state path (default ~/.hermes/bridge_state.json)
 *   HERMES_DEFAULT_SESSION_ID  overrides default_session_id from the config
 *   HERMES_BRIDGE_TZ      time zone for displayed times (default: system zone)
 *
 * Future: a dashboard WebSocket transport (/api/ws, password login + ws-ticket) for
 * sessions the API server cannot write to. Not included.
 */
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME_DIR = join(homedir(), ".hermes");
const RAW_BASE = (process.env.HERMES_BASE_URL || "").trim();
const ROOT = RAW_BASE.replace(/\/+$/, "").replace(/\/v1$/, "");
const CONFIG_PATH = process.env.HERMES_BRIDGE_CONFIG || join(HOME_DIR, "bridge.json");
const KEY_FILE = process.env.HERMES_API_KEY_FILE || join(HOME_DIR, "api_server_key");
const KEY_DIR = process.env.HERMES_PROFILE_KEY_DIR || join(HOME_DIR, "profile_keys");
const TZ = process.env.HERMES_BRIDGE_TZ || undefined;
const VERSION = "0.3.0";
const STATE_PATH = process.env.HERMES_BRIDGE_STATE || join(HOME_DIR, "bridge_state.json"); // delivery_id -> {session_id, after_id, after_ts}; no secrets
const PEER_TIMEOUT_MS = 330000; // server waits up to 300s for the live Bot Chat owner

// ---------- config / auth ----------
function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, CONFIG_PATH);
  return next;
}
function normProfile(p) {
  const v = (p ?? readConfig().default_profile ?? "default").toString().trim();
  if (!v) return "default";
  if (!/^[A-Za-z0-9_.-]+$/.test(v)) throw new Error(`Invalid profile name: ${v}`);
  return v;
}
function keyFor(profile) {
  if (profile === "default") {
    const k = process.env.HERMES_API_KEY || process.env.HERMES_API_SERVER_KEY;
    if (k) return k.trim();
    try {
      return readFileSync(KEY_FILE, "utf8").trim();
    } catch {
      throw new Error(`Missing Hermes API key: set HERMES_API_KEY or put it in ${KEY_FILE} (chmod 600)`);
    }
  }
  const envName = "HERMES_PROFILE_KEY_" + profile.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (process.env[envName]) return process.env[envName].trim();
  try {
    return readFileSync(`${KEY_DIR}/${profile}`, "utf8").trim();
  } catch {
    throw new Error(
      `No API key for profile '${profile}'. Hermes requires each named profile's own API_SERVER_KEY on /p/${profile}/ ` +
        `(the default key gets 401). Put it in ${KEY_DIR}/${profile} (chmod 600) or env ${envName}.`
    );
  }
}
function base(profile) {
  if (!ROOT) throw new Error("HERMES_BASE_URL is not set (e.g. http://<hermes-host>:8642). Add it to this MCP server's env.");
  return profile === "default" ? ROOT : `${ROOT}/p/${encodeURIComponent(profile)}`;
}
function defaultSession() {
  return process.env.HERMES_DEFAULT_SESSION_ID || readConfig().default_session_id || null;
}

// ---------- http ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HermesError extends Error {
  constructor(status, code, message, body) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function call(profile, method, path, { body, timeoutMs = 30000, auth = true, headers = {} } = {}) {
  const h = { ...headers };
  if (auth) h.Authorization = `Bearer ${keyFor(profile)}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  let r;
  try {
    r = await fetch(base(profile) + path, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === "TimeoutError") throw new HermesError(0, "timeout", `Hermes request timed out after ${Math.round(timeoutMs / 1000)}s (${method} ${path})`);
    throw new HermesError(0, "network", `Cannot reach Hermes at ${base(profile)}: ${e?.message || e}`);
  }
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) {
    const code = data?.error?.code || data?.code || `http_${r.status}`;
    const msg = data?.error?.message || data?.message || text.slice(0, 500);
    throw new HermesError(r.status, code, explain(r.status, code, msg, path), data ?? text);
  }
  return data ?? text;
}

function explain(status, code, msg, path) {
  if (status === 409 && code === "permission_denied")
    return (
      `Hermes refused (409 permission_denied): that session is owned by another surface (Desktop/TUI/CLI/messaging). ` +
      `The API server can only write to sessions it created (api_server source). Desktop sessions are only reachable through the ` +
      `dashboard WebSocket (/api/ws) with a dashboard login. Use an API-owned session instead (create_session).`
    );
  if (status === 409 && code === "admission_conflict")
    return `Hermes refused (409 admission_conflict): the session is busy or this idempotency key was already used for different work. ${msg}`;
  if (status === 429) return `Hermes is at its concurrent-run cap (429): ${msg}`;
  if (status === 401) return `Hermes rejected the API key (401) for ${path}: ${msg}`;
  if (status === 404) return `Not found (404) at ${path}: ${msg}`;
  if (status === 503) return `Hermes is draining/storage busy (503): ${msg}`;
  return `Hermes API ${status} ${code}: ${msg}`;
}

// Retry transient refusals (busy session, run cap, draining) with short backoff.
async function withRetry(fn, { tries = 4, onlyPreAdmission = false } = {}) {
  let delay = 2000;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const transient =
        e instanceof HermesError &&
        ((!onlyPreAdmission && e.status === 409 && e.code === "admission_conflict") || e.status === 429 || e.status === 503);
      if (!transient || i >= tries - 1) {
        if (transient) e.message += ` (gave up after ${tries} attempts)`;
        throw e;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 15000);
    }
  }
}

// ---------- helpers ----------
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const tsLocal = (s) =>
  s == null
    ? null
    : new Date(Number(s) * 1000).toLocaleString("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" });

function summarizeSession(s) {
  return {
    id: s.id,
    source: s.source,
    title: s.title,
    message_count: s.message_count,
    last_active: tsLocal(s.last_active),
    started: tsLocal(s.started_at),
    ended: s.ended_at ? tsLocal(s.ended_at) : null,
    parent_session_id: s.parent_session_id,
    writable_via_api: s.source === "api_server",
    preview: s.preview,
  };
}

function runView(r, profile) {
  const out = {
    run_id: r.run_id,
    status: r.status,
    session_id: r.session_id ?? null,
    profile,
  };
  if (TERMINAL.has(r.status)) out.reply = r.output ?? "";
  if (r.error) out.error = r.error;
  if (Array.isArray(r.pending_controls) && r.pending_controls.length) out.pending_controls = r.pending_controls;
  if (r.status === "unknown") out.note = "Gateway restarted mid-turn; later turns in this session wait until resolved.";
  if (r.usage && Object.keys(r.usage).length) out.usage = r.usage;
  return out;
}

async function getRun(profile, runId) {
  return call(profile, "GET", `/v1/runs/${encodeURIComponent(runId)}`);
}

async function waitRun(profile, runId, waitSec) {
  const deadline = Date.now() + Math.max(0, waitSec) * 1000;
  let r = await getRun(profile, runId);
  let delay = 1500;
  while (!TERMINAL.has(r.status) && !(r.pending_controls?.length) && Date.now() < deadline) {
    await sleep(Math.min(delay, Math.max(250, deadline - Date.now())));
    delay = Math.min(delay * 1.5, 5000);
    r = await getRun(profile, runId);
  }
  return r;
}

const asText = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

// ---------- tools ----------
async function tHealth({ profile } = {}) {
  const p = normProfile(profile);
  const lines = [];
  try {
    lines.push("health: " + asText(await call(p, "GET", "/health", { auth: false, timeoutMs: 15000 })));
  } catch (e) {
    lines.push("health: " + e.message);
  }
  try {
    const d = await call(p, "GET", "/health/detailed", { timeoutMs: 15000 });
    lines.push(`detailed: status=${d.status} version=${d.version} gateway=${d.gateway_state} active_api_runs=${d?.readiness?.checks?.background_queues?.active_api_runs}`);
  } catch (e) {
    lines.push("detailed: " + e.message);
  }
  lines.push(`profile=${p} base=${base(p)} default_session_id=${defaultSession() ?? "(unset)"}`);
  return lines.join("\n");
}

async function tCapabilities({ profile } = {}) {
  const p = normProfile(profile);
  const d = await call(p, "GET", "/v1/capabilities");
  const on = Object.entries(d.features || {}).filter(([, v]) => v === true).map(([k]) => k);
  return asText({
    profile: p,
    features_enabled: on,
    session_continuity_header: d.features?.session_continuity_header,
    endpoints: Object.fromEntries(Object.entries(d.endpoints || {}).map(([k, v]) => [k, `${v.method} ${v.path}`])),
  });
}

async function tListSessions({ profile, source, limit = 20, offset = 0, include_cron = false } = {}) {
  const p = normProfile(profile);
  const lim = Math.min(Math.max(1, Number(limit) || 20), 200);
  const qs = new URLSearchParams({ limit: String(include_cron || source ? lim : Math.min(lim * 10, 1000)), offset: String(offset) });
  if (source) qs.set("source", source);
  const d = await call(p, "GET", `/api/sessions?${qs}`);
  let rows = d.data || [];
  if (!include_cron && !source) rows = rows.filter((s) => s.source !== "cron");
  rows = rows.slice(0, lim).map(summarizeSession);
  return asText({ profile: p, count: rows.length, default_session_id: defaultSession(), sessions: rows });
}

function authorLabel(m) {
  const c = typeof m.content === "string" ? m.content : "";
  if (m.role === "assistant") return "hermes";
  if (m.role === "tool") return `tool:${m.tool_name || "?"}`;
  if (m.role !== "user") return m.role;
  const bot = c.match(/^Message from\s+(?:\S+\s+)?([^\n(]+?)\s*\(@([\w.-]+)\)/u);
  if (bot) return `bot:${bot[2]}`;
  if (m.display_kind === "process_complete") return "system:process";
  if (m.display_kind === "internal_notification") return "peer/external";
  if (m.display_kind) return `system:${m.display_kind}`;
  if (c.startsWith("[IMPORTANT:") || c.startsWith("[SYSTEM")) return "system";
  return "owner";
}

async function fetchMessages(p, id, { limit = 200 } = {}) {
  const qs = new URLSearchParams({ inline_images: "false", order: "latest", limit: String(Math.min(Math.max(1, limit), 500)) });
  const d = await call(p, "GET", `/api/sessions/${encodeURIComponent(id)}/messages?${qs}`);
  return (d.data || []).slice().sort((a, b) => Number(a.timestamp) - Number(b.timestamp) || Number(a.id) - Number(b.id));
}

function viewMsg(m, full) {
  return {
    id: m.id,
    at: tsLocal(m.timestamp),
    ts: Number(m.timestamp),
    from: authorLabel(m),
    content: m.content,
    ...(full && m.tool_calls ? { tool_calls: m.tool_calls.map((c) => c.function?.name) } : {}),
  };
}

function parseSince(since) {
  if (since == null || since === "") return null;
  if (typeof since === "number" || /^\d+(\.\d+)?$/.test(String(since))) return Number(since);
  const t = Date.parse(String(since));
  if (Number.isNaN(t)) throw new Error(`Bad 'since' value: ${since} (use unix seconds or ISO 8601)`);
  return t / 1000;
}

async function tReadSession({ session_id, last = 20, since, profile, full = false } = {}) {
  const p = normProfile(profile);
  const id = session_id || defaultSession();
  if (!id) throw new Error("session_id required (no default_session_id configured)");
  const meta = await call(p, "GET", `/api/sessions/${encodeURIComponent(id)}`);
  const n = Math.min(Math.max(1, Number(last) || 20), 500);
  const sinceTs = parseSince(since);
  let msgs = await fetchMessages(p, id, { limit: sinceTs != null ? 500 : Math.min(n * 4 + 20, 500) });
  msgs = msgs.filter((m) => full || m.role === "user" || (m.role === "assistant" && m.content));
  if (sinceTs != null) msgs = msgs.filter((m) => Number(m.timestamp) > sinceTs);
  msgs = msgs.slice(-n).map((m) => viewMsg(m, full));
  return asText({ session: summarizeSession(meta.session || meta), order: "chronological", messages: msgs });
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { deliveries: {} };
  }
}
function rememberDelivery(rec) {
  const st = readState();
  st.deliveries = st.deliveries || {};
  st.deliveries[rec.delivery_id] = rec;
  const keys = Object.keys(st.deliveries);
  for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete st.deliveries[k];
  const tmp = STATE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(st, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, STATE_PATH);
}

async function lastMessageMark(p, id) {
  try {
    const m = await fetchMessages(p, id, { limit: 1 });
    const x = m[m.length - 1];
    return x ? { after_id: Number(x.id), after_ts: Number(x.timestamp) } : { after_id: 0, after_ts: 0 };
  } catch {
    return { after_id: null, after_ts: Date.now() / 1000 - 1 };
  }
}

async function chooseTransport(p, sid) {
  const cfg = readConfig();
  if (sid === cfg.default_session_id && cfg.transport) return cfg.transport;
  const meta = await call(p, "GET", `/api/sessions/${encodeURIComponent(sid)}`);
  const s = meta.session || meta;
  return s.source === "api_server" ? "runs" : "peer_rest";
}

// Bot Chat / non-API sessions: the `hermes peer dm` door (POST /api/sessions/{id}/chat).
// Only pre-admission refusals (429/503) are retried; a timeout or 202 means the message is
// already in the chat, so it is never resent.
async function sendPeer(p, sid, message, author) {
  const mark = await lastMessageMark(p, sid);
  const sent_at = Date.now() / 1000;
  const body = { message: String(message) };
  if (author) body.author = author;
  let d;
  try {
    d = await withRetry(
      () => call(p, "POST", `/api/sessions/${encodeURIComponent(sid)}/chat`, { body, timeoutMs: PEER_TIMEOUT_MS }),
      { tries: 3, onlyPreAdmission: true }
    );
  } catch (e) {
    if (e instanceof HermesError && e.code === "timeout")
      return asText({
        status: "timeout_after_send",
        session_id: sid,
        since: mark.after_ts,
        note: "The request likely reached Hermes; the message is probably in the chat and will be answered there. Do NOT resend. Use check_reply with since.",
      });
    throw e;
  }
  if (d?.object === "hermes.session.chat.queued") {
    const rec = { delivery_id: d.delivery_id, session_id: d.session_id || sid, after_id: mark.after_id, after_ts: mark.after_ts, sent_at, profile: p };
    if (d.delivery_id) rememberDelivery(rec);
    return asText({
      status: "queued",
      delivery_id: d.delivery_id,
      session_id: rec.session_id,
      since: mark.after_ts,
      note: "Delivered into the open Bot Chat; its turn is still running. Do NOT resend. Call check_reply(delivery_id) later.",
    });
  }
  return asText({ status: "completed", session_id: d?.session_id || sid, delivery_id: d?.delivery_id ?? null, reply: d?.message?.content ?? "" });
}

async function tCheckReply({ delivery_id, since, session_id, profile } = {}) {
  let p = normProfile(profile);
  let sid = session_id || defaultSession();
  let afterId = null;
  let afterTs = parseSince(since);
  if (delivery_id) {
    const rec = readState().deliveries?.[delivery_id];
    if (!rec) throw new Error(`Unknown delivery_id ${delivery_id} (not sent by this bridge, or pruned). Use since=<unix ts> instead.`);
    sid = rec.session_id;
    p = rec.profile || p;
    afterId = rec.after_id;
    afterTs = rec.after_ts;
  }
  if (!sid) throw new Error("session_id required");
  if (afterId == null && afterTs == null) throw new Error("Pass delivery_id or since.");
  const msgs = (await fetchMessages(p, sid, { limit: 200 })).filter((m) =>
    afterId != null ? Number(m.id) > afterId : Number(m.timestamp) > afterTs
  );
  const shown = msgs.filter((m) => m.role === "user" || (m.role === "assistant" && m.content));
  const replies = shown.filter((m) => m.role === "assistant");
  return asText({
    session_id: sid,
    delivery_id: delivery_id ?? null,
    answered: replies.length > 0,
    replies: replies.map((m) => ({ id: m.id, at: tsLocal(m.timestamp), content: m.content })),
    new_messages: shown.map((m) => viewMsg(m, false)),
  });
}

async function tCreateSession({ title, profile, make_default = false } = {}) {
  const p = normProfile(profile);
  const d = await call(p, "POST", "/api/sessions", { body: title ? { title } : {} });
  const s = d.session || d;
  if (make_default) writeConfig({ default_session_id: s.id, default_profile: p });
  return asText({ created: summarizeSession(s), made_default: !!make_default });
}

async function tSetDefaultSession({ session_id, profile, transport } = {}) {
  const p = normProfile(profile);
  let t = null;
  if (session_id) {
    const meta = await call(p, "GET", `/api/sessions/${encodeURIComponent(session_id)}`);
    const s = meta.session || meta;
    t = transport || (s.source === "api_server" ? "runs" : "peer_rest");
  }
  const cfg = writeConfig({ default_session_id: session_id || null, default_profile: p, transport: t });
  return asText({ default_session_id: cfg.default_session_id, default_profile: cfg.default_profile, transport: cfg.transport, config: CONFIG_PATH });
}

async function tSend({ message, session_id, profile, wait_sec = 45, instructions, author } = {}) {
  if (!message || !String(message).trim()) throw new Error("message is required");
  const p = normProfile(profile);
  const sid = session_id || defaultSession();
  if (!sid) throw new Error("No session: pass session_id or set one with set_default_session / create_session(make_default=true).");
  const transport = await chooseTransport(p, sid);
  if (transport === "peer_rest") return sendPeer(p, sid, message, author === undefined ? readConfig().default_author || null : author);
  if (transport !== "runs") throw new Error(`Transport '${transport}' is not implemented (dashboard WebSocket is future work).`);
  const body = { input: String(message), session_id: sid };
  if (instructions) body.instructions = String(instructions);
  const started = await withRetry(() => call(p, "POST", "/v1/runs", { body }));
  const r = await waitRun(p, started.run_id, Math.min(Math.max(0, Number(wait_sec) || 0), 600));
  const v = runView(r, p);
  if (!TERMINAL.has(r.status)) v.note = (v.note ? v.note + " " : "") + "Still running; call run_status with this run_id (wait_sec to long-poll).";
  return asText(v);
}

async function tRunStatus({ run_id, profile, wait_sec = 0 } = {}) {
  if (!run_id) throw new Error("run_id required");
  const p = normProfile(profile);
  const r = await waitRun(p, run_id, Math.min(Math.max(0, Number(wait_sec) || 0), 600));
  return asText(runView(r, p));
}

async function tSteer({ run_id, message, profile } = {}) {
  if (!run_id || !message) throw new Error("run_id and message required");
  const p = normProfile(profile);
  const d = await call(p, "POST", `/v1/runs/${encodeURIComponent(run_id)}/steer`, { body: { input: String(message) } });
  return asText(d);
}

async function tStop({ run_id, profile } = {}) {
  if (!run_id) throw new Error("run_id required");
  const p = normProfile(profile);
  const d = await call(p, "POST", `/v1/runs/${encodeURIComponent(run_id)}/stop`, { body: {} });
  const r = await waitRun(p, run_id, 15);
  return asText({ stop: d, now: runView(r, p) });
}

async function tRespondApproval({ run_id, choice, request_id, profile } = {}) {
  if (!run_id || !choice) throw new Error("run_id and choice required");
  const p = normProfile(profile);
  const r = await getRun(p, run_id);
  const pc = (r.pending_controls || []).find((c) => !request_id || c.prompt_id === request_id || c.request_id === request_id);
  if (!pc) throw new Error(`No pending approval on ${run_id}. pending_controls=${JSON.stringify(r.pending_controls || [])}`);
  const body = { request_id: pc.prompt_id ?? pc.request_id, execution_generation: pc.execution_generation ?? r.execution_generation, choice: String(choice) };
  return asText(await call(p, "POST", `/v1/runs/${encodeURIComponent(run_id)}/approval`, { body }));
}

// Back-compat: one-off prompt. Uses session_id if given, else a fresh API session per call (old behaviour).
async function tAsk({ prompt, timeout_sec = 600, session_id, profile } = {}) {
  if (!prompt) throw new Error("prompt is required");
  const p = normProfile(profile);
  const body = { input: String(prompt) };
  if (session_id) body.session_id = session_id;
  const started = await withRetry(() => call(p, "POST", "/v1/runs", { body }));
  const r = await waitRun(p, started.run_id, Math.max(5, Number(timeout_sec) || 600));
  if (TERMINAL.has(r.status)) {
    if (r.status === "completed") return r.output ?? "";
    return `[${r.status}] ${r.output ?? ""}${r.error ? " " + asText(r.error) : ""}`;
  }
  return `Hermes still working after ${timeout_sec}s. run_id=${r.run_id} status=${r.status}. Use run_status to fetch the reply.`;
}

const S = (props, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const profileProp = { type: "string", description: "Hermes profile (default: bridge.json default_profile or 'default'). Named profiles need their own key." };
const TOOLS = [
  { name: "health", description: "Hermes liveness + readiness, and the bridge's default session.", inputSchema: S({ profile: profileProp }), run: tHealth },
  { name: "capabilities", description: "Feature flags and endpoints advertised by /v1/capabilities.", inputSchema: S({ profile: profileProp }), run: tCapabilities },
  {
    name: "list_sessions",
    description: "List recent Hermes sessions (cron hidden unless include_cron or source given). Times in HERMES_BRIDGE_TZ (or system zone). writable_via_api is true only for api_server sessions.",
    inputSchema: S({
      profile: profileProp,
      source: { type: "string", description: "Filter: desktop, api_server, photon, tui, cron, oneshot..." },
      limit: { type: "number", description: "Max rows (default 20, max 200)" },
      offset: { type: "number" },
      include_cron: { type: "boolean" },
    }),
    run: tListSessions,
  },
  {
    name: "read_session",
    description: "Read a session's messages in chronological order with local times and a 'from' label (owner, hermes, bot:<name>, peer/external, system:*). Defaults to the configured Bot Chat. Use since to get only newer messages.",
    inputSchema: S({
      session_id: { type: "string" },
      last: { type: "number", description: "Max messages (default 20, max 500)" },
      since: { type: ["string", "number"], description: "Only messages after this time: unix seconds or ISO 8601" },
      full: { type: "boolean", description: "Include tool rows/calls too" },
      profile: profileProp,
    }),
    run: tReadSession,
  },
  {
    name: "create_session",
    description: "Create an empty API-owned Hermes session (visible in Hermes session lists). make_default saves it to bridge.json.",
    inputSchema: S({ title: { type: "string" }, make_default: { type: "boolean" }, profile: profileProp }),
    run: tCreateSession,
  },
  {
    name: "set_default_session",
    description: "Set (or clear, if session_id omitted) the default session for send/read_session. transport is auto: runs for api_server sessions, peer_rest otherwise.",
    inputSchema: S({ session_id: { type: "string" }, transport: { type: "string", enum: ["runs", "peer_rest"] }, profile: profileProp }),
    run: tSetDefaultSession,
  },
  {
    name: "send",
    description:
      "Send a message to Hermes. Default target is the default bot's Bot Chat (peer_rest: the 'hermes peer dm' door; waits up to ~5 min). Returns {status:'completed', reply} verbatim, or {status:'queued', delivery_id} when the open desktop chat is still working. NEVER resend a queued/timeout_after_send message; use check_reply. For api_server sessions it starts a background run (wait_sec, then run_status/steer/stop).",
    inputSchema: S(
      {
        message: { type: "string" },
        session_id: { type: "string", description: "Default: bridge.json default_session_id (Bot Chat)" },
        wait_sec: { type: "number", description: "runs transport only: 0-600, default 45" },
        instructions: { type: "string", description: "runs transport only: extra system instructions" },
        author: { type: ["object", "null"], description: "peer_rest only: {name, id}; default from bridge.json" },
        profile: profileProp,
      },
      ["message"]
    ),
    run: tSend,
  },
  {
    name: "check_reply",
    description: "After a queued/timed-out send: list new messages after our send and whether Hermes has replied. Pass delivery_id (from send) or since (unix seconds / ISO).",
    inputSchema: S({ delivery_id: { type: "string" }, since: { type: ["string", "number"] }, session_id: { type: "string" }, profile: profileProp }),
    run: tCheckReply,
  },
  {
    name: "run_status",
    description: "(api_server sessions) Status of a run; includes reply (verbatim) once terminal, and pending_controls if it awaits approval. wait_sec long-polls (max 600).",
    inputSchema: S({ run_id: { type: "string" }, wait_sec: { type: "number" }, profile: profileProp }, ["run_id"]),
    run: tRunStatus,
  },
  {
    name: "steer",
    description: "(api_server sessions) Inject a mid-run message into a running turn (delivered as an out-of-band user message).",
    inputSchema: S({ run_id: { type: "string" }, message: { type: "string" }, profile: profileProp }, ["run_id", "message"]),
    run: tSteer,
  },
  { name: "stop", description: "(api_server sessions) Stop a running/queued run; returns its state after up to 15s.", inputSchema: S({ run_id: { type: "string" }, profile: profileProp }, ["run_id"]), run: tStop },
  {
    name: "respond_approval",
    description: "Answer a run's pending approval (choice e.g. once, deny). Uses the current pending_controls identity.",
    inputSchema: S({ run_id: { type: "string" }, choice: { type: "string" }, request_id: { type: "string" }, profile: profileProp }, ["run_id", "choice"]),
    run: tRespondApproval,
  },
  {
    name: "ask",
    description: "Back-compat one-off prompt; returns the reply text. Fresh session unless session_id is given. Waits up to timeout_sec (default 600).",
    inputSchema: S(
      { prompt: { type: "string" }, timeout_sec: { type: "number" }, session_id: { type: "string" }, profile: profileProp },
      ["prompt"]
    ),
    run: tAsk,
  },
];
const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ---------- JSON-RPC ----------
function out(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => id != null && out({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => id != null && out({ jsonrpc: "2.0", id, error: { code, message } });
  try {
    if (method === "initialize") {
      return reply({
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "hermes-grok-bridge", version: VERSION },
      });
    }
    if (method === "notifications/initialized" || method === "initialized" || method?.startsWith("notifications/")) return;
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (method === "tools/call") {
      const t = BY_NAME[params?.name];
      if (!t) throw new Error(`Unknown tool: ${params?.name}`);
      const text = await t.run(params?.arguments || {});
      return reply({ content: [{ type: "text", text: String(text) }] });
    }
    fail(-32601, `Method not found: ${method}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (method === "tools/call") reply({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });
    else fail(-32000, message);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }
  if (msg.method) void handle(msg);
});
