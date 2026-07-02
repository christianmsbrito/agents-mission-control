import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { AgentTask, ReporterMsg, LiveMsg, WebToServerMsg, SessionEvent, PublishedEvent, Session, AppConfig, PersistedEventType, SpawnMsg } from "@mc/shared";
import { validateTemplateInput } from "@mc/shared";
import type { ServerWebSocket } from "bun";
import { Hub } from "./hub.ts";
import { Store, sessionKeyOf, type RecordDiff } from "./store.ts";
import { defaultConfig, applySettings } from "./config.ts";
import { AgentAliasRegistry } from "./aliases.ts";
import { haikuDisplayNameGenerator } from "./displayName.ts";
import {
  buildAskPrompt,
  buildReplyPrompt,
  canonicalHandle,
  compactText,
  parseAliasDirective,
  routedContext,
  sessionRef,
} from "./router.ts";

const PORT = Number(process.env.MC_PORT || 7777);
const TOKEN = process.env.MC_TOKEN || "dev-token";
const WEB_DIR = join(import.meta.dir, "..", "..", "web", "dist");
const EVENTS_LOG = join(homedir(), ".mission-control", "events.jsonl");
const CONFIG_FILE = join(homedir(), ".mission-control", "config.json");

function loadAppConfig(): AppConfig {
  const base = defaultConfig(process.env);
  try {
    return applySettings(base, JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
  } catch {
    return base; // missing/corrupt -> defaults
  }
}

let config = loadAppConfig();

// Persistence store, constructed at the I/O edge (the hub stays pure/in-memory).
// Every store call below is best-effort/guarded — a store failure must never
// break live reporting (mirrors the publishEvent contract).
const DB_FILE = process.env.MC_DB || join(homedir(), ".mission-control", "mc.db");
if (DB_FILE !== ":memory:") {
  try {
    mkdirSync(dirname(DB_FILE), { recursive: true });
  } catch {
    /* best-effort dir creation */
  }
}
const store = new Store(DB_FILE, { retention: config.retention });
// One-time, idempotent: seed active_ms for pre-activeMs sessions from their raw
// samples. Best-effort like every other store call at this edge.
try {
  store.backfillActiveMs();
} catch (err) {
  console.warn("[store] active_ms backfill failed (non-fatal):", err);
}

async function persistConfig(): Promise<void> {
  try {
    await mkdir(join(homedir(), ".mission-control"), { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch {
    /* best-effort, like publishEvent */
  }
}

const aliases = new AgentAliasRegistry(haikuDisplayNameGenerator());
const hub = new Hub(config.staleMs, () => config.categories, aliases);
setInterval(() => {
  const now = Date.now();
  // Snapshot host ids before/after the sweep so we can orphan in the store any
  // host the hub dropped for going stale (clean disconnects go through close()).
  const before = new Set(hub.snapshot().map((r) => r.hostId));
  hub.sweep(now);
  const after = new Set(hub.snapshot().map((r) => r.hostId));
  for (const hostId of before) {
    if (after.has(hostId)) continue;
    try {
      store.onHostOffline(hostId, now);
    } catch {
      /* best-effort */
    }
    setHostOnline(hostId, undefined, false); // emit host.offline (stale sweep)
  }
  try {
    store.maybeCompact(now);
  } catch {
    /* best-effort */
  }
}, 2000);

function pushConfigToReporters(): void {
  for (const r of reporters.values())
    r.send(JSON.stringify({ type: "config", summaries: config.summaries }));
}
function reresolveAndRebroadcast(): void {
  for (const report of hub.snapshot()) hub.ingest(report, Date.now());
}

type WsData =
  | { kind: "report"; hostId: string | null; authed: boolean }
  | { kind: "live"; unsub: (() => void) | null }
  | { kind: "events" };

// Reporter sockets by hostId, so the server can relay commands (focus/kill) to the right host.
const reporters = new Map<string, ServerWebSocket<WsData>>();
// Subscribers to the lifecycle event stream (future consumers).
const eventSinks = new Set<ServerWebSocket<WsData>>();
// Commands awaiting the reporter's confirmation.
const pendingKills = new Map<string, Session | undefined>();
const pendingPrompts = new Map<
  string,
  { session?: Session; text: string; taskId?: string; taskStage?: "ask" | "reply" }
>();
const tasks = new Map<string, AgentTask>();
let nextTask = 1;
// Per-host spawn rate cap (design defense #4): bound how many panes the
// open-trust /ws/live channel can fork on a host within a sliding window.
const recentSpawns = new Map<string, number[]>(); // hostId → recent spawn epoch-ms
const SPAWN_WINDOW_MS = 10_000;
const SPAWN_MAX_PER_WINDOW = 5;

function findSession(sessionId: string): Session | undefined {
  return hub.findSession(sessionId);
}

/** Common BaseEvent fields for a session-scoped published event. */
function sessionEventBase(s: Session) {
  return { sessionId: s.id, hostId: s.hostId, pid: s.pid, ok: true, provider: s.provider, cwd: s.cwd, subject: s.subject };
}

// Tier-3 per-session alert state (so each fires once until the condition resets).
const budgetAlerted = new Set<string>(); // session ids over the budget threshold
const idleAlerted = new Set<string>();   // session ids currently flagged idle
const templateLevels = new Map<string, number>(); // templateId → last-seen derived level
const onlineHosts = new Set<string>();   // hosts with a host.online already emitted

/** Publish a host.online/offline once per transition. */
function setHostOnline(hostId: string, hostLabel: string | undefined, online: boolean): void {
  if (online === onlineHosts.has(hostId)) return; // no transition
  const at = Date.now();
  if (online) onlineHosts.add(hostId); else onlineHosts.delete(hostId);
  void publishEvent({ type: online ? "host.online" : "host.offline", at, hostId, hostLabel });
  persistEvent(online ? "host.online" : "host.offline", `host:${hostId}`, { at, hostId });
}

/** Emit the live lifecycle events for one ingested report's diff. */
function emitLifecycle(diff: RecordDiff, current: Session[], at: number): void {
  for (const s of diff.started)
    void publishEvent({ type: "session.started", at, ...sessionEventBase(s), templateId: s.templateId });
  for (const s of diff.errored)
    void publishEvent({ type: "session.errored", at, ...sessionEventBase(s), templateId: s.templateId, transient: s.errorTransient });
  for (const s of diff.attention) {
    void publishEvent({ type: "session.attention", at, ...sessionEventBase(s), templateId: s.templateId, ask: s.ask, suggestion: s.suggestion });
    persistEvent("session.attention", sessionKeyForLive(s.id), { at, hostId: s.hostId, pid: s.pid, detail: { templateId: s.templateId, ask: s.ask } });
  }
  for (const { session: s, item } of diff.questsCompleted) {
    void publishEvent({ type: "quest.completed", at, ...sessionEventBase(s), templateId: s.templateId, itemKey: item.itemKey, questSubject: item.subject });
    persistEvent("quest.completed", sessionKeyForLive(s.id), { at, hostId: s.hostId, pid: s.pid, detail: { itemKey: item.itemKey, subject: item.subject, templateId: s.templateId } });
  }
  for (const s of diff.closed) {
    budgetAlerted.delete(s.id); idleAlerted.delete(s.id); // session gone — reset its alert state
    if (!s.templateId) continue; // troop.closed only for templated sessions
    void publishEvent({ type: "troop.closed", at, ...sessionEventBase(s), templateId: s.templateId,
      summary: s.summary, costUsd: s.costUsd, tokensIn: s.tokensIn, tokensOut: s.tokensOut,
      durationMs: s.startedAt ? at - s.startedAt : undefined });
    persistEvent("troop.closed", sessionKeyForLive(s.id), { at, hostId: s.hostId, pid: s.pid,
      detail: { templateId: s.templateId, provider: s.provider, costUsd: s.costUsd, tokensIn: s.tokensIn, tokensOut: s.tokensOut, subject: s.subject, summary: s.summary } });
  }

  // Tier 3: budget + idle, scanned over the live sessions (fire once per session).
  const budget = config.budgetUsd ?? 0;
  const idleMs = (config.idleMinutes ?? 0) * 60_000;
  for (const s of current) {
    if (budget > 0 && (s.costUsd ?? 0) >= budget && !budgetAlerted.has(s.id)) {
      budgetAlerted.add(s.id);
      void publishEvent({ type: "budget.exceeded", at, ...sessionEventBase(s), templateId: s.templateId, costUsd: s.costUsd ?? 0, thresholdUsd: budget });
      persistEvent("budget.exceeded", sessionKeyForLive(s.id), { at, hostId: s.hostId, pid: s.pid, detail: { costUsd: s.costUsd, thresholdUsd: budget, templateId: s.templateId } });
    }
    if (idleMs > 0 && s.templateId) {
      const idleFor = at - (s.lastActivityAt ?? s.startedAt);
      if (!s.active && idleFor >= idleMs && !idleAlerted.has(s.id)) {
        idleAlerted.add(s.id);
        void publishEvent({ type: "troop.idle", at, ...sessionEventBase(s), templateId: s.templateId, idleMs: idleFor });
        persistEvent("troop.idle", sessionKeyForLive(s.id), { at, hostId: s.hostId, pid: s.pid, detail: { idleMs: idleFor, templateId: s.templateId } });
      } else if (s.active) {
        idleAlerted.delete(s.id); // active again → allow a future idle alert
      }
    }
  }

  // template.leveled_up: recompute derived level for templates touched this tick.
  const touched = new Set<string>();
  for (const s of current) if (s.templateId) touched.add(s.templateId);
  for (const s of diff.closed) if (s.templateId) touched.add(s.templateId);
  for (const templateId of touched) {
    let lvl: number | undefined; let name: string | undefined;
    try { const t = store.getTemplate(templateId); lvl = t?.level; name = t?.name; } catch { /* best-effort */ }
    if (lvl == null) continue;
    const prev = templateLevels.get(templateId);
    templateLevels.set(templateId, lvl);
    if (prev != null && lvl > prev) {
      void publishEvent({ type: "template.leveled_up", at, templateId, name, level: lvl, prevLevel: prev });
      persistEvent("template.leveled_up", `template:${templateId}`, { at, detail: { level: lvl, prevLevel: prev, name } });
    }
  }
}

/** Best-effort persisted-event write at the server edge. A store failure must
 * never break live reporting/routing, so it's always swallowed. */
function persistEvent(
  type: PersistedEventType,
  sessionKey: string,
  fields: { at: number; hostId?: string; pid?: number; detail?: Record<string, unknown> },
): void {
  try {
    store.event({ type, sessionKey, ...fields });
  } catch {
    /* best-effort persistence */
  }
}

/** Durable session key for a live session, resolved by its `${hostId}:${pid}`
 * id; falls back to that id string when the session can't be resolved (it may
 * have just exited). */
function sessionKeyForLive(sessionId: string): string {
  const live = findSession(sessionId);
  return live ? sessionKeyOf(live) : sessionId;
}

function promptKey(hostId: string, pid: number, commandId?: string): string {
  return commandId ? `${hostId}:${commandId}` : `${hostId}:${pid}`;
}

function commandId(prefix = "cmd"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function relayPrompt(session: Session, text: string, id = commandId("prompt")): boolean {
  const reporter = reporters.get(session.hostId);
  if (!reporter) return false;
  pendingPrompts.set(promptKey(session.hostId, session.pid, id), { session, text });
  reporter.send(JSON.stringify({ type: "prompt", pid: session.pid, text: text.slice(0, 4000), commandId: id }));
  return true;
}

function relayTaskPrompt(session: Session, task: AgentTask, text: string, stage: "ask" | "reply"): boolean {
  const reporter = reporters.get(session.hostId);
  if (!reporter) return false;
  const id = stage === "ask" ? task.id : `${task.id}:reply`;
  pendingPrompts.set(promptKey(session.hostId, session.pid, id), { session, text, taskId: task.id, taskStage: stage });
  reporter.send(JSON.stringify({ type: "prompt", pid: session.pid, text: text.slice(0, 4000), commandId: id }));
  return true;
}

function touchTask(task: AgentTask, patch: Partial<AgentTask>): AgentTask {
  Object.assign(task, patch, { updatedAt: Date.now() });
  return task;
}

function createTask(to: string, text: string, source?: Session): AgentTask | { error: string; status: number } {
  const target = hub.findSessionByHandle(to);
  if (!target) return { error: `target ${to} is not live`, status: 404 };
  const from = source?.handle;
  const now = Date.now();
  const task: AgentTask = {
    id: `mc-task-${nextTask++}`,
    from,
    fromSessionId: source?.id,
    to,
    toSessionId: target.id,
    text,
    state: "submitted",
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(task.id, task);

  // Persist the routed task. Carry the durable session keys for both sides
  // (handle numbers recycle across reboots) plus the human-readable handles.
  const toKey = sessionKeyOf(target);
  const fromKey = source ? sessionKeyOf(source) : task.fromSessionId;
  persistEvent("task.routed", toKey, {
    at: now,
    hostId: target.hostId,
    pid: target.pid,
    detail: {
      taskId: task.id,
      toHandle: to,
      ...(from ? { fromHandle: from } : {}),
      toKey,
      ...(fromKey ? { fromKey } : {}),
      text,
    },
  });

  if (!relayTaskPrompt(target, task, buildAskPrompt(task), "ask")) {
    touchTask(task, { state: "failed", promptOk: false, error: `reporter for ${target.hostId} is not connected` });
  }
  return task;
}

function routeTaskReply(task: AgentTask, text: string): void {
  touchTask(task, { state: "replied", reply: text, repliedAt: Date.now() });

  // The event is "about" the target session, so its sessionKey is the target's
  // durable key (resolve live, else fall back to the task's `${hostId}:${pid}`
  // toSessionId).
  const target = hub.findSessionByHandle(task.to);
  const toKey = target ? sessionKeyOf(target) : task.toSessionId;

  if (task.from) {
    const source = hub.findSessionByHandle(task.from);
    if (!source) {
      touchTask(task, { replyDelivered: false, error: `source ${task.from} is not live` });
    } else if (!relayTaskPrompt(source, task, buildReplyPrompt(task), "reply")) {
      touchTask(task, { replyDelivered: false, error: `reporter for ${source.hostId} is not connected` });
    }
  }

  // Persist after the delivery attempt so `ok` reflects whether the reply
  // actually reached the source (replyDelivered is set false on failure above).
  persistEvent("task.replied", toKey, {
    at: task.repliedAt ?? Date.now(),
    hostId: target?.hostId,
    pid: target?.pid,
    detail: { taskId: task.id, reply: text, ok: task.replyDelivered !== false },
  });
}

function latestOpenTaskForTarget(session: Session): AgentTask | undefined {
  return [...tasks.values()]
    .filter((t) => t.toSessionId === session.id && t.state === "prompted" && !t.reply)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function apiAuthed(req: Request, url: URL): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer === TOKEN || req.headers.get("x-mc-token") === TOKEN || url.searchParams.get("token") === TOKEN;
}

async function readJson(req: Request): Promise<any | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

const RESOLUTIONS = new Set(["raw", "hour", "day", "auto"]);

/** Safe numeric query param: returns the number only if finite, else undefined. */
function numParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Non-empty string query param, else undefined. */
function strParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  return raw != null && raw !== "" ? raw : undefined;
}

/** Parse + clamp the /api/sessions query string into a store.listSessions filter.
 * limit/offset are clamped HERE (parse layer) so a hostile query can't hit the DB. */
function parseSessionsFilter(url: URL): Parameters<typeof store.listSessions>[0] {
  const filter: Parameters<typeof store.listSessions>[0] = {};
  const state = strParam(url, "state");
  const provider = strParam(url, "provider");
  const category = strParam(url, "category");
  const cwd = strParam(url, "cwd");
  const host = strParam(url, "host");
  if (state) filter.state = state as any;
  if (provider) filter.provider = provider;
  if (category) filter.category = category;
  if (cwd) filter.cwd = cwd;
  if (host) filter.host = host;
  const since = numParam(url, "since");
  const until = numParam(url, "until");
  if (since !== undefined) filter.since = since;
  if (until !== undefined) filter.until = until;
  const minTokens = numParam(url, "minTokens");
  if (minTokens !== undefined) filter.minTokens = Math.max(0, Math.floor(minTokens));
  const limit = numParam(url, "limit");
  if (limit !== undefined) filter.limit = Math.min(1000, Math.max(1, Math.floor(limit)));
  const offset = numParam(url, "offset");
  if (offset !== undefined) filter.offset = Math.max(0, Math.floor(offset));
  const q = strParam(url, "q");
  if (q) filter.q = q;
  const sort = strParam(url, "sort");
  if (sort && SESSION_SORTS.has(sort)) filter.sort = sort as any;
  const order = strParam(url, "order");
  if (order === "asc" || order === "desc") filter.order = order;
  return filter;
}

const SESSION_SORTS = new Set(["lastSeen", "started", "cost", "tokens", "context"]);

/** Parse the /api/quests query string into a store.listQuests filter. */
function parseQuestsFilter(url: URL): Parameters<typeof store.listQuests>[0] {
  const filter: Parameters<typeof store.listQuests>[0] = {};
  const status = strParam(url, "status");
  if (status && ["pending", "in_progress", "completed"].includes(status)) filter.status = status as any;
  const provider = strParam(url, "provider");
  if (provider) filter.provider = provider;
  const category = strParam(url, "category");
  if (category) filter.category = category;
  const state = strParam(url, "state");
  if (state) filter.sessionState = state as any;
  const limit = numParam(url, "limit");
  if (limit !== undefined) filter.limit = Math.min(2000, Math.max(1, Math.floor(limit)));
  return filter;
}

/** Parse + validate /api/stats/timeseries opts. Returns null on bad params (→ 400). */
function parseTimeseriesOpts(url: URL): Parameters<typeof store.timeseries>[0] | null {
  const since = numParam(url, "since");
  const until = numParam(url, "until");
  if (since === undefined || until === undefined || until < since) return null;
  const bucket = strParam(url, "bucket") ?? "day";
  if (!["hour", "day"].includes(bucket)) return null;
  const metric = strParam(url, "metric") ?? "cost";
  if (!["cost", "tokens"].includes(metric)) return null;
  const groupBy = strParam(url, "groupBy") ?? "none";
  if (!["none", "category", "provider"].includes(groupBy)) return null;
  const opts: Parameters<typeof store.timeseries>[0] = {
    since, until, bucket: bucket as any, metric: metric as any, groupBy: groupBy as any,
  };
  const provider = strParam(url, "provider"); if (provider) opts.provider = provider;
  const category = strParam(url, "category"); if (category) opts.category = category;
  const host = strParam(url, "host"); if (host) opts.host = host;
  return opts;
}

/** Parse + clamp the /api/events query string into a store.listEvents filter. */
function parseEventsFilter(url: URL): Parameters<typeof store.listEvents>[0] {
  const filter: Parameters<typeof store.listEvents>[0] = {};
  const type = strParam(url, "type");
  const sessionKey = strParam(url, "sessionKey");
  if (type) filter.type = type as any;
  if (sessionKey) filter.sessionKey = sessionKey;
  const since = numParam(url, "since");
  const until = numParam(url, "until");
  if (since !== undefined) filter.since = since;
  if (until !== undefined) filter.until = until;
  const limit = numParam(url, "limit");
  if (limit !== undefined) filter.limit = Math.min(1000, Math.max(1, Math.floor(limit)));
  return filter;
}

/** Read-only JSON GET endpoints over the persistence store. Returns null for
 * any request these don't handle, so the caller can fall through. */
function handleReadApi(req: Request, url: URL): Response | null {
  if (req.method !== "GET") return null;
  const { pathname } = url;

  if (pathname === "/api/sessions") {
    const filter = parseSessionsFilter(url);
    // { sessions, total } so the client can paginate (total reflects the filter, not the page).
    return Response.json({ sessions: store.listSessions(filter), total: store.countSessions(filter) });
  }
  if (pathname === "/api/events") {
    return Response.json(store.listEvents(parseEventsFilter(url)));
  }
  if (pathname === "/api/facets") {
    return Response.json(store.facets(parseSessionsFilter(url)));
  }
  if (pathname === "/api/quests") {
    const f: Parameters<typeof store.listManagedQuests>[0] = {};
    const status = strParam(url, "status");
    if (status && ["pending", "in_progress", "completed", "cancelled"].includes(status)) f.status = status as any;
    const templateId = strParam(url, "templateId");
    if (templateId) f.templateId = templateId;
    const sessionKey = strParam(url, "sessionKey");
    if (sessionKey) f.sessionKey = sessionKey;
    return Response.json(store.listManagedQuests(f));
  }
  if (pathname === "/api/templates") return Response.json(store.listTemplates());
  if (pathname.startsWith("/api/templates/")) {
    const id = decodeURIComponent(pathname.slice("/api/templates/".length));
    const template = store.getTemplate(id);
    return template ? Response.json(template) : Response.json({ error: "not found" }, { status: 404 });
  }
  if (pathname === "/api/stats/timeseries") {
    const opts = parseTimeseriesOpts(url);
    if (!opts) return Response.json({ error: "bad params" }, { status: 400 });
    return Response.json(store.timeseries(opts));
  }
  // /api/sessions/:key and /api/sessions/:key/samples. The key may contain
  // colons (host:pid:started) and is url-encoded, so take the whole remainder
  // after the prefix and decode it (stripping a trailing /samples first).
  const prefix = "/api/sessions/";
  if (pathname.startsWith(prefix)) {
    let rest = pathname.slice(prefix.length);
    if (rest.endsWith("/quests")) {
      const key = decodeURIComponent(rest.slice(0, -"/quests".length));
      return Response.json(store.getQuests(key));
    }
    if (rest.endsWith("/subagents")) {
      const key = decodeURIComponent(rest.slice(0, -"/subagents".length));
      return Response.json(store.getSubagents(key));
    }
    if (rest.endsWith("/samples")) {
      const key = decodeURIComponent(rest.slice(0, -"/samples".length));
      const opts: Parameters<typeof store.getSamples>[1] = {};
      const since = numParam(url, "since");
      const until = numParam(url, "until");
      if (since !== undefined) opts.since = since;
      if (until !== undefined) opts.until = until;
      const resolution = strParam(url, "resolution");
      if (resolution && RESOLUTIONS.has(resolution)) opts.resolution = resolution as any;
      return Response.json(store.getSamples(key, opts));
    }
    const key = decodeURIComponent(rest);
    const result = store.getSession(key);
    if (!result) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(result);
  }
  return null;
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  // Template create/edit/delete are public — same trust model as the rest of the API
  // and /ws/live (which already allows unauthed kill/prompt and template deploys).
  // A template is just a spawn recipe; gating its creation protected nothing the open
  // deploy channel didn't already expose.
  if (url.pathname === "/api/templates" && req.method === "POST") {
    const body = await readJson(req);
    const v = validateTemplateInput(body ?? {});
    if (!v.ok) return json({ ok: false, error: v.error }, 400);
    try {
      store.createTemplate({ ...v.value, createdAt: Date.now() });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
    const at = Date.now();
    void publishEvent({ type: "template.created", at, templateId: v.value.id, name: v.value.name });
    persistEvent("template.created", `template:${v.value.id}`, { at, detail: { name: v.value.name } });
    return json(store.getTemplate(v.value.id));
  }
  if (url.pathname.startsWith("/api/templates/") && (req.method === "PATCH" || req.method === "DELETE")) {
    const id = decodeURIComponent(url.pathname.slice("/api/templates/".length));
    try {
      if (req.method === "DELETE") {
        const name = store.getTemplate(id)?.name; // capture before archiving
        const ok = store.archiveTemplate(id, Date.now());
        if (ok) {
          const at = Date.now();
          void publishEvent({ type: "template.deleted", at, templateId: id, name });
          persistEvent("template.deleted", `template:${id}`, { at });
        }
        return json({ ok });
      }
      const body = await readJson(req);
      const patch: any = {};
      for (const k of ["name", "provider", "args", "prompt", "cwd", "backend", "rpg"]) if (body?.[k] !== undefined) patch[k] = body[k];
      const ok = store.updateTemplate(id, patch);
      if (ok) {
        const at = Date.now();
        void publishEvent({ type: "template.updated", at, templateId: id, name: store.getTemplate(id)?.name });
        persistEvent("template.updated", `template:${id}`, { at });
      }
      return json({ ok });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  // Managed quests — public CRUD (same trust model as templates / deploy).
  if (url.pathname === "/api/quests" && req.method === "POST") {
    const body = await readJson(req);
    const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
    if (!subject) return json({ ok: false, error: "subject required" }, 400);
    try {
      const q = store.createQuest({
        subject,
        body: typeof body?.body === "string" ? body.body : undefined,
        templateId: typeof body?.templateId === "string" ? body.templateId : undefined,
        sessionKey: typeof body?.sessionKey === "string" ? body.sessionKey : undefined,
        now: Date.now(),
      });
      return json(q);
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }
  if (url.pathname.startsWith("/api/quests/") && (req.method === "PATCH" || req.method === "DELETE")) {
    const id = decodeURIComponent(url.pathname.slice("/api/quests/".length));
    try {
      if (req.method === "DELETE") return json({ ok: store.deleteQuest(id) });
      const body = await readJson(req);
      const patch: any = {};
      for (const k of ["subject", "body", "status", "templateId", "sessionKey"]) if (body?.[k] !== undefined) patch[k] = body[k];
      return json({ ok: store.updateQuest(id, patch, Date.now()) });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  if (!apiAuthed(req, url)) return json({ ok: false, error: "unauthorized" }, 401);

  if (url.pathname === "/api/agents" && req.method === "GET") {
    return json({ ok: true, agents: hub.listAliases() });
  }

  if (url.pathname.startsWith("/api/tasks/") && req.method === "GET") {
    const id = decodeURIComponent(url.pathname.slice("/api/tasks/".length));
    const task = tasks.get(id);
    return task ? json({ ok: true, task }) : json({ ok: false, error: "task not found" }, 404);
  }

  if (url.pathname === "/api/ask" && req.method === "POST") {
    const body = await readJson(req);
    const to = canonicalHandle(body?.to);
    const from = body?.from === undefined ? undefined : canonicalHandle(body.from);
    const text = compactText(body?.text);
    if (!to || !text || (body?.from !== undefined && !from)) return json({ ok: false, error: "invalid ask" }, 400);

    const source = from ? hub.findSessionByHandle(from) : undefined;
    if (from && !source) return json({ ok: false, error: `source ${from} is not live` }, 404);

    const task = createTask(to, text, source);
    if ("error" in task) return json({ ok: false, error: task.error }, task.status);
    return json({ ok: task.state !== "failed", task }, task.state === "failed" ? 503 : 202);
  }

  if (url.pathname === "/api/intercept" && req.method === "POST") {
    const body = await readJson(req);
    const provider = String(body?.provider ?? "").trim();
    const providerSessionId = typeof body?.providerSessionId === "string" ? body.providerSessionId : undefined;
    const cwd = typeof body?.cwd === "string" ? body.cwd : undefined;
    const prompt = compactText(body?.prompt);
    if (!provider || !prompt) return json({ ok: false, error: "invalid intercept" }, 400);

    const source = hub.findSessionByProviderSession(provider, providerSessionId, cwd);
    const directive = parseAliasDirective(prompt);
    if (!directive) return json({ ok: true, intercepted: false, routed: false, ...sessionRef(source) });
    if (!source) {
      return json({
        ok: false,
        intercepted: true,
        routed: false,
        error: `source ${provider} session is ambiguous or not live; cannot route a terminal alias reply safely`,
      }, 409);
    }
    if (source.handle === directive.to) {
      return json({
        ok: false,
        intercepted: true,
        routed: false,
        ...sessionRef(source),
        error: `target ${directive.to} is this session; choose a different mc:a<n> handle`,
      }, 409);
    }

    const task = createTask(directive.to, directive.text, source);
    if ("error" in task) {
      return json({ ok: false, intercepted: true, routed: false, error: task.error, ...sessionRef(source) }, task.status);
    }
    return json({
      ok: task.state !== "failed",
      intercepted: true,
      routed: true,
      task,
      ...sessionRef(source),
      context: routedContext(task),
    }, task.state === "failed" ? 503 : 202);
  }

  if (url.pathname === "/api/complete" && req.method === "POST") {
    const body = await readJson(req);
    const provider = String(body?.provider ?? "").trim();
    const providerSessionId = typeof body?.providerSessionId === "string" ? body.providerSessionId : undefined;
    const cwd = typeof body?.cwd === "string" ? body.cwd : undefined;
    const text = compactText(body?.text ?? body?.lastAssistantMessage);
    if (!provider || !text) return json({ ok: false, error: "invalid completion" }, 400);

    const session = hub.findSessionByProviderSession(provider, providerSessionId, cwd);
    if (!session) return json({ ok: true, routed: false, error: "source session not live" });
    const task = latestOpenTaskForTarget(session);
    if (!task) return json({ ok: true, routed: false });

    routeTaskReply(task, text);
    return json({ ok: true, routed: true, task });
  }

  if (url.pathname === "/api/reply" && req.method === "POST") {
    const body = await readJson(req);
    const taskId = String(body?.taskId ?? "").trim();
    const text = compactText(body?.text);
    const task = tasks.get(taskId);
    if (!task || !text) return json({ ok: false, error: "invalid reply" }, task ? 400 : 404);

    routeTaskReply(task, text);
    return json({ ok: true, task });
  }


  return json({ ok: false, error: "not found" }, 404);
}

/** Publish a lifecycle event: live to /ws/events subscribers + durable to events.jsonl. */
async function publishEvent(e: PublishedEvent): Promise<void> {
  const line = JSON.stringify(e);
  for (const sink of eventSinks) sink.send(line);
  try {
    await mkdir(join(homedir(), ".mission-control"), { recursive: true });
    await appendFile(EVENTS_LOG, line + "\n");
  } catch {
    /* log best-effort */
  }
}

const server = Bun.serve<WsData, undefined>({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/ws/report") {
      if (srv.upgrade(req, { data: { kind: "report", hostId: null, authed: false } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/ws/live") {
      if (srv.upgrade(req, { data: { kind: "live", unsub: null } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/ws/events") {
      if (srv.upgrade(req, { data: { kind: "events" } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, hosts: hub.snapshot().length });
    }
    if (url.pathname.startsWith("/api/")) {
      const read = handleReadApi(req, url);
      if (read) return read;
      return handleApi(req, url);
    }

    // static web bundle
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = join(WEB_DIR, p);
    if (existsSync(file)) return new Response(Bun.file(file));
    const idx = join(WEB_DIR, "index.html");
    if (existsSync(idx)) return new Response(Bun.file(idx));
    return new Response("mission-control: run `bun run build:web`", { status: 200 });
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === "live") {
        const send = (msg: LiveMsg) => ws.send(JSON.stringify(msg));
        ws.data.unsub = hub.subscribe(send);
        send({ type: "settings", config });
      } else if (ws.data.kind === "events") {
        eventSinks.add(ws);
      }
    },
    message(ws, raw) {
      if (ws.data.kind === "live") {
        // Browser -> server: focus a session's terminal (relay to its host's reporter).
        let m: WebToServerMsg;
        try {
          m = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (m.type === "set-settings") {
          config = applySettings(config, m.patch);
          void persistConfig();
          hub.setStaleMs(config.staleMs);
          try {
            store.setRetention(config.retention);
          } catch {
            /* best-effort */
          }
          if (m.patch.categories) reresolveAndRebroadcast();
          if (m.patch.summaries) pushConfigToReporters();
          hub.broadcastSettings(config);
          return;
        }
        if (m.type === "focus" || m.type === "kill" || m.type === "prompt") {
          const sep = m.sessionId.lastIndexOf(":");
          const hostId = m.sessionId.slice(0, sep);
          const pid = Number(m.sessionId.slice(sep + 1));
          const reporter = reporters.get(hostId);
          if (!reporter || !Number.isInteger(pid)) return;
          const key = `${hostId}:${pid}`;
          if (m.type === "kill") {
            pendingKills.set(key, findSession(m.sessionId));
            reporter.send(JSON.stringify({ type: "kill", pid }));
          } else if (m.type === "prompt") {
            const text = String(m.text ?? "").slice(0, 4000);
            if (!text.trim()) return;
            const id = commandId("prompt");
            pendingPrompts.set(promptKey(hostId, pid, id), { session: findSession(m.sessionId), text });
            reporter.send(JSON.stringify({ type: "prompt", pid, text, commandId: id }));
          } else {
            reporter.send(JSON.stringify({ type: "focus", pid }));
          }
        }
        // /ws/live is open-trust like kill/prompt; cwd existence validation lives in the reporter and argv is built literally (Task 3), so no command injection.
        if (m.type === "spawn") {
          const reporter = reporters.get(m.hostId);
          if (!reporter) return;
          let template;
          try {
            template = store.getTemplate(m.templateId);
          } catch {
            template = null;
          }
          if (!template || template.archivedAt) return; // template is the guard
          // Per-host rate cap (design defense #4): only authorized spawns counted.
          const now = Date.now();
          const fresh = (recentSpawns.get(m.hostId) ?? []).filter((t) => t > now - SPAWN_WINDOW_MS);
          if (fresh.length >= SPAWN_MAX_PER_WINDOW) {
            console.warn(`[spawn] rate limit hit for host ${m.hostId}: dropping spawn (${fresh.length}/${SPAWN_MAX_PER_WINDOW} in ${SPAWN_WINDOW_MS}ms)`);
            return;
          }
          fresh.push(now);
          recentSpawns.set(m.hostId, fresh);
          const id = commandId("spawn");
          // Fold selected quests into the marching orders + mark them in_progress.
          let questOrders = "";
          if (Array.isArray(m.questIds) && m.questIds.length) {
            const quests = m.questIds.map((qid) => { try { return store.getQuest(qid); } catch { return null; } })
              .filter((q): q is NonNullable<typeof q> => !!q);
            if (quests.length) {
              questOrders = "\n\nQuests:\n" + quests.map((q) => `- ${q.subject}${q.body ? `: ${q.body}` : ""}`).join("\n");
              for (const q of quests) { try { store.updateQuest(q.id, { status: "in_progress" }, Date.now()); } catch { /* best-effort */ } }
            }
          }
          const base = (m.promptOverride ?? template.prompt) ?? "";
          const prompt = (base + questOrders).slice(0, 4000) || undefined;
          const cwd = m.cwd ?? template.cwd ?? null;
          reporter.send(
            JSON.stringify({
              type: "spawn",
              commandId: id,
              templateId: template.id,
              cmd: template.provider,
              args: [...template.args],
              prompt,
              cwd,
              windowId: m.windowId,
              name: template.name,
              backend: template.backend,
            } satisfies SpawnMsg),
          );
          return;
        }
        return;
      }
      let msg: ReporterMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "hello") {
        if (msg.token !== TOKEN) {
          ws.close(4001, "bad token");
          return;
        }
        ws.data.authed = true;
        ws.data.hostId = msg.hostId;
        reporters.set(msg.hostId, ws);
        setHostOnline(msg.hostId, msg.hostLabel, true);
        ws.send(JSON.stringify({ type: "config", summaries: config.summaries }));
        return;
      }
      if (!ws.data.authed) return;
      if (msg.type === "report") {
        const now = Date.now();
        hub.ingest(msg.report, now);
        let diff: RecordDiff | undefined;
        try {
          diff = store.record(msg.report, now);
        } catch {
          /* best-effort persistence */
        }
        if (diff) emitLifecycle(diff, msg.report.sessions, Date.now());
      }
      else if (msg.type === "ping" && ws.data.hostId) hub.touch(ws.data.hostId, Date.now());
      else if (msg.type === "killed" && ws.data.hostId) {
        const key = `${ws.data.hostId}:${msg.pid}`;
        const s = pendingKills.get(key);
        pendingKills.delete(key);
        const at = Date.now();
        void publishEvent({
          type: "session.killed",
          at,
          sessionId: key,
          hostId: ws.data.hostId,
          pid: msg.pid,
          ok: msg.ok,
          provider: s?.provider,
          cwd: s?.cwd,
          subject: s?.subject,
        });
        persistEvent("session.killed", sessionKeyForLive(key), {
          at,
          hostId: ws.data.hostId,
          pid: msg.pid,
          detail: { ok: msg.ok, provider: s?.provider, cwd: s?.cwd, subject: s?.subject },
        });
      } else if (msg.type === "prompted" && ws.data.hostId) {
        const key = promptKey(ws.data.hostId, msg.pid, msg.commandId);
        const p = pendingPrompts.get(key);
        pendingPrompts.delete(key);
        const sessionId = `${ws.data.hostId}:${msg.pid}`;
        if (p?.taskId) {
          const task = tasks.get(p.taskId);
          if (task && p.taskStage === "ask") {
            touchTask(task, { state: msg.ok ? "prompted" : "failed", promptOk: msg.ok });
            if (!msg.ok) touchTask(task, { error: "target prompt failed" });
          } else if (task && p.taskStage === "reply") {
            touchTask(task, { replyDelivered: msg.ok });
            if (!msg.ok) touchTask(task, { error: "reply prompt failed" });
          }
        }
        const at = Date.now();
        void publishEvent({
          type: "session.prompted",
          at,
          sessionId,
          hostId: ws.data.hostId,
          pid: msg.pid,
          ok: msg.ok,
          text: p?.text ?? "",
          provider: p?.session?.provider,
          cwd: p?.session?.cwd,
          subject: p?.session?.subject,
        });
        persistEvent("session.prompted", sessionKeyForLive(sessionId), {
          at,
          hostId: ws.data.hostId,
          pid: msg.pid,
          detail: {
            ok: msg.ok,
            text: p?.text ?? "",
            provider: p?.session?.provider,
            cwd: p?.session?.cwd,
            subject: p?.session?.subject,
          },
        });
      } else if (msg.type === "spawned" && ws.data.hostId) {
        const hostId = ws.data.hostId;
        const at = Date.now();
        // Deliberate dual identifier: the live `sessionId` is pane-scoped
        // (`hostId:pane:paneId`) for display, while the persisted `sessionKey` is
        // template-scoped (`template:templateId`) so events group under the template.
        // Both are display/grouping ids, NOT registry-resolvable session keys —
        // the real session row is created later via the normal report path once
        // the MC_TEMPLATE_ID-tagged process is seen.
        const sessionId = msg.paneId ? `${hostId}:pane:${msg.paneId}` : `${hostId}:spawn`;
        void publishEvent({
          type: "session.spawned",
          at,
          sessionId,
          hostId,
          pid: msg.pid ?? 0,
          ok: msg.ok,
          templateId: msg.templateId,
          windowId: msg.windowId,
          paneId: msg.paneId,
          subject: msg.error,
        });
        persistEvent("session.spawned", `template:${msg.templateId}`, {
          at,
          hostId,
          pid: msg.pid ?? undefined,
          detail: { ok: msg.ok, windowId: msg.windowId, paneId: msg.paneId, error: msg.error },
        });
      }
    },
    close(ws) {
      if (ws.data.kind === "live") ws.data.unsub?.();
      else if (ws.data.kind === "events") eventSinks.delete(ws);
      else if (ws.data.kind === "report" && ws.data.hostId) {
        if (reporters.get(ws.data.hostId) === ws) reporters.delete(ws.data.hostId);
        hub.dropHost(ws.data.hostId);
        try {
          store.onHostOffline(ws.data.hostId, Date.now());
        } catch {
          /* best-effort persistence */
        }
        setHostOnline(ws.data.hostId, undefined, false); // emit host.offline (socket closed)
      }
    },
  },
});

console.log(`[server] mission-control on http://localhost:${server.port}`);

export { server, hub, store };
