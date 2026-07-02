import { readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderPlugin, Enrichment, EnrichContext } from "./types.ts";
import type { ProcInfo } from "../procscan.ts";
import { extractClis, commandFromInput } from "../clis.ts";
import { estimateCost, type SubSession } from "@mc/shared";

/** Tiny stable string hash (djb2) -> base36. For WorkItem.itemKey (no crypto needed). */
function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Claude Code encodes a cwd into its projects/ dir by replacing non-alnum with "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The transcript for a process is the one created when that process started:
 * a session's file is born at session start (≈ process start). Matching by
 * birthtime-closest-to-startedAt disambiguates multiple sessions in one cwd —
 * picking "newest" would collapse them all onto the same file.
 */
async function transcriptForStart(dir: string, startedAt: number): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let best: { path: string; delta: number } | null = null;
  for (const e of entries) {
    if (!e.endsWith(".jsonl")) continue;
    const p = join(dir, e);
    try {
      const s = await stat(p);
      const born = s.birthtimeMs || s.ctimeMs;
      const delta = Math.abs(born - startedAt);
      if (!best || delta < best.delta) best = { path: p, delta };
    } catch {
      /* skip */
    }
  }
  return best?.path ?? null;
}

/** Parse a Claude transcript JSONL into enrichment. Pure-ish (takes raw text). */
export function parseClaudeTranscript(text: string): Enrichment {
  let tokensIn = 0;
  let tokensCacheRead = 0;
  let tokensCacheWrite = 0;
  let tokensOut = 0;
  let contextTokens = 0; // last turn's full prompt + output = live window occupancy
  let model: string | undefined;
  let summary: string | undefined;
  let lastAssistantWasError = false; // recency-bounded: did the LAST assistant turn error?
  let trailingErrors = 0; // consecutive trailing API errors
  let lastErrorText = "";
  let lastErrorAt = 0;
  const tools = new Set<string>();
  let latestTodos: any[] | undefined; // last TodoWrite.input.todos wins
  const convo: string[] = []; // recent role-tagged text for the LLM recap

  // Claude Code logs each assistant message more than once (streaming partial +
  // final), so summing every entry double-counts tokens. Keep only the LAST
  // occurrence of each message.id (its final usage); entries without an id stay.
  const parsed: any[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      parsed.push(JSON.parse(t));
    } catch {
      /* skip */
    }
  }
  const lastIdx = new Map<string, number>();
  parsed.forEach((ev, i) => {
    const id = ev?.message?.id;
    if (typeof id === "string") lastIdx.set(id, i);
  });
  const entries = parsed.filter((ev, i) => {
    const id = ev?.message?.id;
    return typeof id !== "string" || lastIdx.get(id) === i;
  });

  for (const ev of entries) {
    if (ev.type === "summary" && typeof ev.summary === "string") summary = ev.summary;
    const msg = ev.message ?? ev;
    // isApiErrorMessage rides on assistant entries. Real successful turns OMIT
    // the key entirely, so we can't latch on the boolean alone — instead track
    // recency: on EVERY assistant entry, recompute whether it was an error. A
    // normal successful turn (no key) flips this back to false, clearing a prior
    // error. Only assistant entries flip it; a tool_result/user line between
    // turns must NOT falsely clear a still-pending error.
    const isErr = ev.isApiErrorMessage === true;
    const role = ev.type === "user" || ev.type === "assistant" ? ev.type : msg?.role;
    if (role === "assistant") {
      lastAssistantWasError = isErr;
      if (isErr) {
        trailingErrors++;
        lastErrorText =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join(" ")
              : "";
        const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
        if (!Number.isNaN(ts)) lastErrorAt = ts;
      } else {
        trailingErrors = 0;
      }
    }
    if (isErr) continue; // don't fold error text into recap/summary/tools
    if (msg?.usage) {
      const fresh = msg.usage.input_tokens ?? 0;
      const cacheWrite = msg.usage.cache_creation_input_tokens ?? 0;
      const cacheRead = msg.usage.cache_read_input_tokens ?? 0;
      const out = msg.usage.output_tokens ?? 0;
      tokensIn += fresh;
      tokensCacheWrite += cacheWrite;
      tokensCacheRead += cacheRead;
      tokensOut += out;
      // Occupancy is whatever the model held on the LAST turn that carried usage,
      // not the running sum. Error turns carry no usage and `continue` above, so
      // this naturally holds the last successful turn (and tracks compaction).
      contextTokens = fresh + cacheWrite + cacheRead + out;
    }
    if (typeof msg?.model === "string") model = msg.model;
    if (Array.isArray(msg?.content)) {
      for (const c of msg.content) {
        if (c?.type === "tool_use" && typeof c.name === "string") {
          if (c.name === "TodoWrite" && Array.isArray(c.input?.todos)) {
            latestTodos = c.input.todos;
          }
          // Surface the specific skill (and sub-agent type) instead of a bare label.
          if (c.name === "Skill" && typeof c.input?.skill === "string") {
            tools.add(`Skill:${c.input.skill}`);
          } else if (
            (c.name === "Task" || c.name === "Agent") &&
            typeof c.input?.subagent_type === "string"
          ) {
            tools.add(`Agent:${c.input.subagent_type}`);
          } else {
            tools.add(c.name);
            // Surface the actual CLIs invoked via the shell tool.
            if (c.name === "Bash") {
              const cmd = commandFromInput(c.input);
              if (cmd) for (const cli of extractClis(cmd)) tools.add(`$${cli}`);
            }
          }
        }
        if (c?.type === "text" && typeof c.text === "string") {
          if (!summary) summary = c.text.slice(0, 140);
          if (role) convo.push(`${role}: ${c.text}`);
        }
      }
    } else if (typeof msg?.content === "string" && role) {
      convo.push(`${role}: ${msg.content}`);
    }
  }
  const out: Enrichment = { tokensIn, tokensCacheRead, tokensCacheWrite, tokensOut };
  if (contextTokens) out.contextTokens = contextTokens;
  if (model) out.model = model;
  if (summary) out.summary = summary;
  if (lastAssistantWasError) {
    out.errored = true;
    // transient = a short run of a known infra/recoverable error; otherwise persistent.
    const TRANSIENT =
      /temporarily unavailable|overloaded|unable to connect|stream idle timeout|rate spike|rate.?limit|cannot determine the safety|classifier|\b(429|500|502|503|504|529)\b|timed? ?out|connection (error|reset)/i;
    out.errorTransient = trailingErrors <= 2 && TRANSIENT.test(lastErrorText);
    if (lastErrorAt) out.errorAt = lastErrorAt;
    // Surface a short human crash description (TASK-12). Set in lockstep with
    // `errored` (same recency gate) so it never outlives the error on recovery.
    const reason = lastErrorText.trim();
    if (reason) out.crashReason = reason.slice(0, 200);
  }
  if (tools.size) out.toolsUsed = [...tools];
  if (latestTodos && latestTodos.length) {
    const items = latestTodos
      .filter((t) => t && typeof t.content === "string")
      .map((t, i) => {
        const status = ["pending", "in_progress", "completed"].includes(t.status)
          ? t.status
          : "pending";
        const wi: NonNullable<Enrichment["workItems"]>[number] = {
          itemKey: hashKey(t.content),
          subject: t.content,
          status,
          position: i,
        };
        if (typeof t.activeForm === "string") wi.activeForm = t.activeForm;
        return wi;
      });
    if (items.length) out.workItems = items;
  }
  if (convo.length) {
    out.summaryInput = convo.slice(-12).join("\n");
    const opening = convo.filter((c) => c.startsWith("user:")).slice(0, 3);
    if (opening.length) out.subjectInput = opening.join("\n").slice(0, 2000);
  }
  return out;
}

/** The four billable token counters a subagent transcript contributes. */
export type SubagentUsage = {
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
};

/** One subagent transcript to fold in: a stable cache `key` (path:mtime:size) and
 * a lazy `read()` that's only invoked on a cache miss. */
export type SubagentEntry = { key: string; read: () => string };

/**
 * Sum the token usage across a session's subagent transcripts.
 *
 * Newer Claude Code writes each Task/Agent subagent to its OWN transcript under
 * `<projectDir>/<sessionId>/subagents/agent-*.jsonl` — those tokens are absent
 * from the main `<sessionId>.jsonl` the parser reads, so a subagent-driven session
 * (thin orchestrator, heavy delegates) massively under-reports its cost.
 *
 * `cache` is keyed by an append-stable `path:mtime:size` string and MUST be scoped
 * to a single session (the reporter keeps one per sessionId): a file that grew
 * gets a fresh key and is re-parsed, its old key evicted here so the map can't
 * grow without bound across ticks. Unchanged files are served from cache without
 * re-reading — the reporter ticks every few seconds over potentially dozens of
 * these files.
 */
export function sumSubagentUsage(
  entries: SubagentEntry[],
  cache: Map<string, SubagentUsage>,
): SubagentUsage {
  const total: SubagentUsage = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 };
  const live = new Set<string>();
  for (const e of entries) {
    live.add(e.key);
    let u = cache.get(e.key);
    if (!u) {
      const p = parseClaudeTranscript(e.read());
      u = {
        tokensIn: p.tokensIn ?? 0,
        tokensOut: p.tokensOut ?? 0,
        tokensCacheRead: p.tokensCacheRead ?? 0,
        tokensCacheWrite: p.tokensCacheWrite ?? 0,
      };
      cache.set(e.key, u);
    }
    total.tokensIn += u.tokensIn;
    total.tokensOut += u.tokensOut;
    total.tokensCacheRead += u.tokensCacheRead;
    total.tokensCacheWrite += u.tokensCacheWrite;
  }
  for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
  return total;
}

/**
 * Fold subagent token usage into a base enrichment's four counters. Deliberately
 * touches ONLY the token counters: `contextTokens` is the main session's live-window
 * occupancy (a snapshot, not a sum) and `model`/`summary`/`toolsUsed`/errors stay the
 * main session's.
 */
export function addSubagentUsage(base: Enrichment, u: SubagentUsage): void {
  base.tokensIn = (base.tokensIn ?? 0) + u.tokensIn;
  base.tokensOut = (base.tokensOut ?? 0) + u.tokensOut;
  base.tokensCacheRead = (base.tokensCacheRead ?? 0) + u.tokensCacheRead;
  base.tokensCacheWrite = (base.tokensCacheWrite ?? 0) + u.tokensCacheWrite;
}

/** Derive the subagent's stable id from its transcript filename:
 * `agent-<hash>.jsonl` → `<hash>`. Used only as a fallback when the transcript
 * itself carries no `agentId`. Never throws — an off-convention name maps to its
 * bare stem. */
export function agentIdFromName(name: string): string {
  return name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
}

/** Scan a transcript for its self-reported `agentId` (present on entries in newer
 * Claude) and the min/max entry timestamp. A single cheap pass so we don't widen
 * {@link parseClaudeTranscript}'s return shape (which ripples through Session). */
function scanSubagentMeta(text: string): { agentId?: string; firstAt?: number; lastAt?: number } {
  let agentId: string | undefined;
  let firstAt: number | undefined;
  let lastAt: number | undefined;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (!agentId && typeof ev?.agentId === "string") agentId = ev.agentId;
    const ts = ev?.timestamp ? Date.parse(ev.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (firstAt === undefined || ts < firstAt) firstAt = ts;
      if (lastAt === undefined || ts > lastAt) lastAt = ts;
    }
  }
  return { agentId, firstAt, lastAt };
}

/**
 * Build a {@link SubSession} from one subagent transcript. Pure: takes raw text
 * plus the fallback `agentId` (the filename hash) and an optional `kind` (the
 * subagent type, sourced from the `.meta.json` sidecar — it is NOT in the
 * transcript). Reuses {@link parseClaudeTranscript} for the deduped token/tool
 * counters, then adds the subagent-scoped fields (cost, peak context, time bounds).
 */
export function subSessionFromText(text: string, fallbackAgentId: string, kind?: string): SubSession {
  const p = parseClaudeTranscript(text);
  const { agentId, firstAt, lastAt } = scanSubagentMeta(text);
  const tokensIn = p.tokensIn ?? 0;
  const tokensOut = p.tokensOut ?? 0;
  const tokensCacheRead = p.tokensCacheRead ?? 0;
  const tokensCacheWrite = p.tokensCacheWrite ?? 0;
  const s: SubSession = {
    agentId: agentId ?? fallbackAgentId,
    tokensIn,
    tokensOut,
    tokensCacheRead,
    tokensCacheWrite,
  };
  if (kind) s.kind = kind;
  if (p.model) s.model = p.model;
  if (p.contextTokens) s.peakContextTokens = p.contextTokens;
  if (p.toolsUsed?.length) s.toolsUsed = p.toolsUsed;
  const cost = estimateCost(p.model, tokensIn, tokensOut, tokensCacheRead, tokensCacheWrite);
  if (cost !== undefined) s.costUsd = cost;
  if (firstAt !== undefined) s.firstAt = firstAt;
  if (lastAt !== undefined) s.lastAt = lastAt;
  return s;
}

/** One subagent transcript to break down: an append-stable cache `key`
 * (path:mtime:size), the `agentId` fallback (filename hash), the `kind`
 * (from the sidecar, when known), and a lazy `read()` invoked on a cache miss. */
export type SubagentFile = { key: string; agentId: string; kind?: string; read: () => string };

/**
 * Compute one {@link SubSession} per subagent transcript, memoized per `key`.
 * Cache contract mirrors {@link sumSubagentUsage}: unchanged files (same
 * `path:mtime:size` key) are served without re-reading; keys absent this tick are
 * evicted so the map can't grow without bound. Cache MUST be scoped per parent
 * session.
 */
export function buildSubSessions(
  files: SubagentFile[],
  cache: Map<string, SubSession>,
): SubSession[] {
  const live = new Set<string>();
  const out: SubSession[] = [];
  for (const f of files) {
    live.add(f.key);
    let s = cache.get(f.key);
    if (!s) {
      s = subSessionFromText(f.read(), f.agentId, f.kind);
      cache.set(f.key, s);
    }
    out.push(s);
  }
  for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
  return out;
}

/** Sum the four token counters across a set of SubSessions (for the total-fold). */
function sumSubSessions(subs: SubSession[]): SubagentUsage {
  const total: SubagentUsage = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 };
  for (const s of subs) {
    total.tokensIn += s.tokensIn ?? 0;
    total.tokensOut += s.tokensOut ?? 0;
    total.tokensCacheRead += s.tokensCacheRead ?? 0;
    total.tokensCacheWrite += s.tokensCacheWrite ?? 0;
  }
  return total;
}

/** Per-session SubSession cache (the itemized breakdown), keyed by sessionId. Kept
 * module-level so it survives across reporter ticks; one inner map per session ever
 * enriched. The fold reuses these SubSessions for the total, so a single cache
 * memoizes both the breakdown and the token-sum. */
const subSessionCaches = new Map<string, Map<string, SubSession>>();
function subSessionCacheFor(sessionId: string): Map<string, SubSession> {
  let c = subSessionCaches.get(sessionId);
  if (!c) subSessionCaches.set(sessionId, (c = new Map()));
  return c;
}

/** Read the `agentType` (the subagent's `kind`) from a transcript's `.meta.json`
 * sidecar (`agent-<hash>.meta.json`). The type is NOT in the transcript itself —
 * only the sidecar carries it. Returns undefined when absent/unreadable. */
function agentTypeFromSidecar(subDir: string, transcriptName: string): string | undefined {
  const metaPath = join(subDir, transcriptName.replace(/\.jsonl$/, ".meta.json"));
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    return typeof meta?.agentType === "string" ? meta.agentType : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fold this session's subagent transcripts into `out`: sums their tokens into the
 * headline counters (so totals stay main + Σ subagents) AND emits a per-subagent
 * breakdown on `out.subSessions`. Never throws: a missing subagents dir (older
 * Claude, or none spawned) or an unreadable file degrades to the main-transcript
 * totals — matching the enrich contract that one bad file can't kill the host report.
 */
async function foldSubagents(dir: string, sessionId: string, out: Enrichment): Promise<void> {
  const subDir = join(dir, sessionId, "subagents");
  let names: string[];
  try {
    names = await readdir(subDir);
  } catch {
    return; // no subagents dir
  }
  const files: SubagentFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const p = join(subDir, name);
    try {
      const s = await stat(p);
      files.push({
        key: `${p}:${s.mtimeMs}:${s.size}`,
        agentId: agentIdFromName(name),
        kind: agentTypeFromSidecar(subDir, name),
        read: () => readFileSync(p, "utf8"),
      });
    } catch {
      /* skip unreadable */
    }
  }
  if (!files.length) return;
  const subs = buildSubSessions(files, subSessionCacheFor(sessionId));
  // Keep the total-fold (headline = main + Σ subagents) sourced from the same
  // SubSessions, so the breakdown and the total can never disagree.
  addSubagentUsage(out, sumSubSessions(subs));
  out.subSessions = subs;
}

/** Shape of the pid->sessionId map file, incl. the freshness timestamps it carries. */
export type SessionMeta = {
  sessionId?: string;
  cwd?: string;
  status?: string;
  /** Epoch ms the file was last written. */
  updatedAt?: number;
  /** Epoch ms the `status` field last changed (preferred over updatedAt for freshness). */
  statusUpdatedAt?: number;
};

/** Default age (ms) before a busy/shell `active` flag is treated as stale (env MC_ACTIVE_TTL_MS). */
export const ACTIVE_TTL_MS = Number(process.env.MC_ACTIVE_TTL_MS || 300_000);

/** Claude maintains ~/.claude/sessions/<pid>.json mapping pid -> sessionId + live status. */
async function sessionMeta(home: string, pid: number): Promise<SessionMeta | null> {
  try {
    return JSON.parse(await Bun.file(join(home, ".claude", "sessions", `${pid}.json`)).text());
  } catch {
    return null;
  }
}

/**
 * Live status from the pid->sessionId map, independent of any transcript.
 * busy/shell = processing now; waiting = blocked on the user; idle = turn done.
 *
 * `active` is GATED on freshness: Claude writes `status:"shell"` on a shell-escape
 * and then stops updating the file, so a stale `status` would otherwise pin a long-idle
 * session "running" forever. We age `active` out via the file's own
 * `statusUpdatedAt`/`updatedAt` epoch (or, when absent, the transcript mtime). A status
 * with NO timestamp at all is treated as fresh (legacy files / no recency to consult).
 * `attention` is deliberately NOT aged — a session legitimately stays "awaiting" while
 * the user is away; the staleness bug is specifically about "running".
 */
export function statusOnly(
  meta: SessionMeta | null,
  now: number = Date.now(),
  activeTtlMs: number = ACTIVE_TTL_MS,
): Enrichment {
  const out: Enrichment = {};
  if (meta?.sessionId) out.providerSessionId = meta.sessionId;
  if (meta?.status) {
    const wantActive = meta.status === "busy" || meta.status === "shell";
    // Prefer the explicit status timestamp, else the file write time. A status file
    // with NO timestamp at all (legacy Claude) carries no recency to consult, so we
    // trust the status as-is — better than demoting a session on an unrelated signal.
    const fresh = meta.statusUpdatedAt ?? meta.updatedAt;
    out.active = wantActive && (fresh === undefined || now - fresh <= activeTtlMs);
    out.attention = meta.status === "waiting"; // NOT aged — see doc comment
  }
  return out;
}

export const claudePlugin: ProviderPlugin = {
  id: "claude",
  defaultCategory: "code",
  matchProcess(p: ProcInfo) {
    return /(^|\/)claude(\s|$)/.test(p.args) || p.comm === "claude";
  },
  async enrich(p, cwd, ctx: EnrichContext): Promise<Enrichment> {
    const now = ctx.now ?? Date.now();
    const ttl = ctx.activeTtlMs ?? ACTIVE_TTL_MS;
    const meta = await sessionMeta(ctx.home, p.pid);
    const projectCwd = meta?.cwd ?? cwd;
    if (!projectCwd) return {};
    const dir = join(ctx.home, ".claude", "projects", encodeProjectDir(projectCwd));

    // Resolve THIS session's transcript. When the pid->sessionId map names it,
    // that file is authoritative: use it exactly, and never fall back to a
    // sibling. A brand-new session writes no transcript until its first turn, so
    // its <sessionId>.jsonl may not exist yet — falling back to the newest
    // sibling in the cwd would report another session's tokens/summary/activity
    // as if they were this one's. Birthtime matching is only for the legacy case
    // where no sessions/<pid>.json exists (older Claude with no sessionId).
    let file: string | null = null;
    if (meta?.sessionId) {
      const candidate = join(dir, `${meta.sessionId}.jsonl`);
      if (await Bun.file(candidate).exists()) file = candidate;
    } else {
      file = await transcriptForStart(dir, ctx.startedAt);
    }
    if (!file) return statusOnly(meta, now, ttl);

    const out = parseClaudeTranscript(await Bun.file(file).text());
    try {
      out.lastActivityAt = (await stat(file)).mtimeMs;
    } catch {
      /* ignore */
    }
    // Fold in subagent transcripts (their tokens live in a sibling dir, absent from
    // the main file) so subagent-driven sessions report their true cost. sessionId
    // scopes both the dir and the cache; the legacy birthtime-matched path has no id.
    if (meta?.sessionId) await foldSubagents(dir, meta.sessionId, out);
    Object.assign(out, statusOnly(meta, now, ttl));
    // Active guard: the pid->sessionId live status is authoritative/real-time, so a
    // session that is actively processing right now can never be "crashed" — clear a
    // stale transcript-derived error (and its crash detail) in lockstep.
    if (out.active) {
      delete out.errored;
      delete out.errorTransient;
      delete out.errorAt;
      delete out.crashReason;
    }
    return out;
  },
};
