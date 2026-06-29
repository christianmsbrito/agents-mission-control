import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { Database } from "bun:sqlite";
import type { PersistedSession, SessionSample, PersistedEvent } from "@mc/shared";
import { assembleHermes, type HermesSession, type HermesMessage } from "../../../../reporter/src/providers/hermes.ts";
import type { BackfillAdapter, BackfillOpts, RawSession } from "../types.ts";
import { buildClosedSession, trimTail } from "./_common.ts";

/** A full hermes `sessions` row (the columns the backfill reads). `started_at`
 * and `ended_at` are epoch SECONDS (×1000 → ms). The cost columns are 0 in
 * practice, so we leave costUsd undefined and let the orchestrator estimate from
 * the (real) token counts. */
export type HermesRow = HermesSession & {
  id: string;
  source: string;
  started_at: number;
  ended_at?: number;
  estimated_cost_usd?: number;
  actual_cost_usd?: number;
};

/** A hermes `messages` row as backfill reads it (carries tool_name + timestamp). */
export type HermesRowMessage = HermesMessage & { tool_name?: string | null; timestamp?: number };

/** One discovered hermes session: its row + chronological messages. */
type HermesRaw = { session: HermesRow; messages: HermesRowMessage[] };

/**
 * Fixed source → category map. Hermes is a global daemon (no cwd), so the live
 * cwd rules can't refine it — the source is the only role signal. We set the
 * category on the session ourselves; with empty backfill rules the orchestrator's
 * resolveCategory falls back to it via the providerDefault arg, leaving it intact.
 */
const SOURCE_CATEGORY: Record<string, string> = {
  cli: "personal",
  cron: "infra",
  telegram: "personal",
  curator: "research",
};

/** Distinct tool names off the message rows, in first-seen order. assembleHermes
 * doesn't read tool_name (it only walks user/assistant content), so the backfill
 * derives the tool set here for the session.tool event bookends. */
function distinctTools(messages: HermesRowMessage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    const t = m.tool_name;
    if (typeof t === "string" && t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Pure: a hermes sessions row + its messages → persisted closed-session row.
 * Reuses assembleHermes for tokens/subject/summary-input, then layers on the
 * backfill specifics: epoch-seconds→ms timestamps, cwd null (global daemon),
 * source→category, resumeId only for `cli` sessions, the message-derived tool
 * set, and no time-series samples (points: []).
 */
export function hermesToImport(
  s: HermesRow,
  messages: HermesRowMessage[],
): { session: PersistedSession; samples: SessionSample[]; events: PersistedEvent[] } {
  const enr = assembleHermes(s, messages);
  // assembleHermes carries tokens + subjectInput (+ a heuristic summary from the
  // title, which buildClosedSession ignores so BF10's Haiku phase fills it). It
  // does NOT read tool_name, so attach the message-derived tool set here.
  const tools = distinctTools(messages);
  if (tools.length) enr.toolsUsed = tools;

  const category = SOURCE_CATEGORY[s.source] ?? "personal";
  const startedAt = s.started_at * 1000;
  const endedAt = (s.ended_at ?? s.started_at) * 1000;

  return buildClosedSession({
    provider: "hermes",
    sessionKey: s.id,
    // Only `cli` hermes sessions are resumable; the rest disable the resume button.
    resumeId: s.source === "cli" ? s.id : undefined,
    cwd: null, // hermes is a global daemon — no per-session cwd.
    startedAt,
    endedAt,
    category,
    enrichment: enr,
    points: [], // hermes has no per-turn time-series.
    errored: false,
  });
}

/** Role-tagged conversation tail for the Haiku enrichment phase. Genuinely reuses
 * the recap text assembleHermes assembles (summaryInput), trimmed — mirrors the
 * codex adapter's `trimTail(parseCodexRollout(text).summaryInput)`. */
function hermesEnrichInput(s: HermesRow, messages: HermesRowMessage[]): string {
  return trimTail(assembleHermes(s, messages).summaryInput ?? "");
}

function dbPathFor(home: string): string {
  return join(home, ".hermes", "state.db");
}

export const hermesBackfillAdapter: BackfillAdapter = {
  id: "hermes",
  available(opts?: { home?: string }): boolean {
    const home = opts?.home ?? os.homedir();
    return existsSync(dbPathFor(home));
  },
  *discover(opts: BackfillOpts): Iterable<RawSession> {
    const home = opts.home ?? os.homedir();
    const path = dbPathFor(home);
    if (!existsSync(path)) return;
    const db = new Database(path, { readonly: true });
    try {
      const where = opts.includeHermesCron ? "" : " WHERE source != 'cron'";
      const rows = db.query(`SELECT * FROM sessions${where}`).all() as HermesRow[];
      const msgStmt = db.query(
        "SELECT role, content, tool_name, timestamp FROM messages WHERE session_id = ? ORDER BY rowid ASC",
      );
      for (const session of rows) {
        const messages = msgStmt.all(session.id) as HermesRowMessage[];
        const raw: HermesRaw = { session, messages };
        yield raw;
      }
    } finally {
      db.close();
    }
  },
  sessionKey(raw: RawSession): string {
    return (raw as HermesRaw).session.id;
  },
  toImport(raw: RawSession) {
    const r = raw as HermesRaw;
    return hermesToImport(r.session, r.messages);
  },
  enrichInput(raw: RawSession): string {
    const r = raw as HermesRaw;
    try {
      return hermesEnrichInput(r.session, r.messages);
    } catch {
      return "";
    }
  },
};
