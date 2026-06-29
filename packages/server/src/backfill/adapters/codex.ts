import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { PersistedSession, SessionSample, PersistedEvent } from "@mc/shared";
import { parseCodexRollout } from "../../../../reporter/src/providers/codex.ts";
import type { BackfillAdapter, BackfillOpts, RawSession } from "../types.ts";
import { buildClosedSession, trimTail, type Point } from "./_common.ts";

/** One discovered codex rollout on disk. */
type CodexRaw = { path: string; mtime: number };

/** The canonical 8-4-4-4-12 UUID trailing `rollout-<ISO>-<UUID>.jsonl`, or null.
 * Anchored on the UUID shape — the ISO timestamp prefix also contains hyphens, so
 * a loose `[0-9a-f-]+` would bleed into it. This is the same UUID as
 * session_meta.id on real data; it is the single source of truth for the key. */
function codexFilenameUuid(path: string): string | null {
  return (
    path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? null
  );
}

/** Pre-parse persistence key for a rollout: the filename UUID, else the full path
 * (kept as the legacy fallback so a non-UUID filename still produces a stable key
 * for the skip-if-exists probe). */
function codexSessionKey(raw: CodexRaw): string {
  return codexFilenameUuid(raw.path) ?? raw.path;
}

/** Parse JSONL into the `{type, payload}` events, unwrapping the envelope the
 * same way parseCodexRollout does (`ev.payload ?? ev`) so our walk reads the
 * same fields. Never throws on a bad line. */
function rolloutEvents(text: string): { ts: number; type: string | undefined; payload: any; raw: any }[] {
  const out: { ts: number; type: string | undefined; payload: any; raw: any }[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    const p = ev.payload ?? ev;
    const ts = typeof ev.timestamp === "string" ? Date.parse(ev.timestamp) : NaN;
    // Prefer the payload's own type (token_count/function_call live there), else
    // the envelope type (session_meta carries its type at the top level).
    const type = typeof p?.type === "string" ? p.type : typeof ev.type === "string" ? ev.type : undefined;
    out.push({ ts, type, payload: p, raw: ev });
  }
  return out;
}

/**
 * Pure rollout-text -> persisted-row conversion. Reuses parseCodexRollout for
 * the token/tool/model/context aggregates (no duplicate aggregation), parses the
 * first session_meta line itself for the session id / cwd / start timestamp, and
 * walks the token_count events for the per-hour cumulative sample points and the
 * MAX per-turn occupancy. Never throws on garbage — a rollout with no session_meta
 * and no parseable usage yields a minimal closed session with no samples (falling
 * back to mtime for the timeline).
 */
export function codexToImport(
  text: string,
  meta: { mtime: number; sessionKey?: string },
): { session: PersistedSession; samples: SessionSample[]; events: PersistedEvent[] } {
  const enr = parseCodexRollout(text);
  const evs = rolloutEvents(text);

  // session_meta carries the resumable id (== filename UUID), cwd, and start ts.
  // The id/timestamp/cwd live under payload (verified against real rollouts), but
  // tolerate top-level too.
  const metaEv = evs.find((e) => e.type === "session_meta");
  const mp = metaEv?.payload ?? {};
  const sessionId: string | undefined =
    typeof mp.id === "string" ? mp.id : typeof metaEv?.raw?.id === "string" ? metaEv.raw.id : undefined;
  const cwd: string | null = typeof mp.cwd === "string" ? mp.cwd : null;
  const metaTs = typeof mp.timestamp === "string" ? Date.parse(mp.timestamp) : NaN;

  let firstTs: number | null = Number.isNaN(metaTs) ? null : metaTs;
  let lastTs: number | null = null;
  const points: Point[] = [];

  for (const e of evs) {
    if (!Number.isNaN(e.ts)) {
      if (firstTs == null || e.ts < firstTs) firstTs = e.ts;
      if (lastTs == null || e.ts > lastTs) lastTs = e.ts;
    }
    if (e.type !== "token_count") continue;
    const info = e.payload?.info;
    if (!info) continue;
    const total = info.total_token_usage;
    // codex has NO cache-write tokens; cached_input_tokens is cache-read.
    const cached = total?.cached_input_tokens ?? 0;
    const cumIn = Math.max(0, (total?.input_tokens ?? 0) - cached);
    const cumCacheRead = cached;
    const cumOut = total?.output_tokens ?? 0;
    // per-turn occupancy = last_token_usage.total_tokens (full working set held).
    const occupancy = info.last_token_usage?.total_tokens ?? 0;
    if (Number.isNaN(e.ts)) continue; // can't place an untimestamped point in a bucket
    points.push({
      at: e.ts,
      cost_usd: null,
      tokens_in: cumIn,
      tokens_out: cumOut,
      tokens_cache_read: cumCacheRead,
      tokens_cache_write: 0,
      context_tokens: occupancy,
      context_window: typeof info.model_context_window === "number" ? info.model_context_window : null,
      cpu: null,
      mem_mb: null,
      active: 0,
    });
  }

  const startedAt = firstTs ?? meta.mtime;
  const endedAt = lastTs ?? meta.mtime;

  // Single key source: prefer the filename-derived UUID (what sessionKey() returns
  // for the skip-if-exists check) so the written registry key always matches the
  // key the orchestrator probed. On real data session_meta.id == the filename UUID;
  // if they ever diverge (filename scheme change), warn and trust the filename so
  // the skip-check and the write can never key different rows.
  let key = meta.sessionKey ?? sessionId ?? "";
  if (meta.sessionKey && sessionId && meta.sessionKey !== sessionId) {
    console.warn(
      `[backfill:codex] session_meta.id (${sessionId}) != filename UUID (${meta.sessionKey}); using filename UUID as session key`,
    );
  }

  // No session id resolvable (meta-less rollout, no filename UUID): buildClosedSession
  // throws so the orchestrator skips it rather than importing a `sessionKey:""` row.
  return buildClosedSession({
    provider: "codex",
    sessionKey: key,
    // codex sessions are resumable via `codex resume <id>` with this UUID.
    resumeId: sessionId,
    cwd,
    startedAt,
    endedAt,
    category: "review", // provider default; orchestrator may refine via cwd rules
    enrichment: enr,
    points,
  });
}

/** Role-tagged conversation tail for the Haiku enrichment phase. Reuses the
 * recap text parseCodexRollout already assembles (summaryInput), trimmed. */
function codexEnrichInput(text: string): string {
  return trimTail(parseCodexRollout(text).summaryInput);
}

/** Recursively collect rollout-*.jsonl under <root> (YYYY/MM/DD nesting). */
function walkRollouts(root: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(root, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkRollouts(p));
    } else if (name.endsWith(".jsonl") && name.includes("rollout-")) {
      out.push(p);
    }
  }
  return out;
}

export const codexBackfillAdapter: BackfillAdapter = {
  id: "codex",
  available(opts?: { home?: string }): boolean {
    return existsSync(join(opts?.home ?? os.homedir(), ".codex", "sessions"));
  },
  *discover(opts: BackfillOpts): Iterable<RawSession> {
    const home = opts.home ?? os.homedir();
    const root = join(home, ".codex", "sessions");
    for (const path of walkRollouts(root)) {
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      const raw: CodexRaw = { path, mtime };
      yield raw;
    }
  },
  sessionKey(raw: RawSession): string {
    return codexSessionKey(raw as CodexRaw);
  },
  toImport(raw: RawSession) {
    const r = raw as CodexRaw;
    const text = readFileSync(r.path, "utf8");
    // Pass the filename-derived UUID so toImport writes the SAME key the
    // skip-if-exists check (sessionKey) probed — single key source. Undefined
    // for a non-UUID filename, where toImport falls back to session_meta.id (and
    // throws if neither resolves, so a keyless rollout is skipped, not imported).
    return codexToImport(text, { mtime: r.mtime, sessionKey: codexFilenameUuid(r.path) ?? undefined });
  },
  enrichInput(raw: RawSession): string {
    const r = raw as CodexRaw;
    try {
      return codexEnrichInput(readFileSync(r.path, "utf8"));
    } catch {
      return "";
    }
  },
};
