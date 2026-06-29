import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { PersistedSession, SessionSample, PersistedEvent } from "@mc/shared";
import { parseClaudeTranscript } from "../../../../reporter/src/providers/claude.ts";
import type { BackfillAdapter, BackfillOpts, RawSession } from "../types.ts";
import { buildClosedSession, trimTail, type Point, type BuildEnrichment } from "./_common.ts";

/** One discovered openclaw transcript on disk. */
type OpenClawRaw = { path: string; sessionId: string; cwd: string | null; mtime: number };

/**
 * IMPORTANT format note: OpenClaw transcripts are NOT in claude's usage shape.
 *
 * The reporter's openclaw plugin runs the text through `parseClaudeTranscript`,
 * but that parser reads claude's `usage.input_tokens / cache_read_input_tokens /
 * cache_creation_input_tokens / output_tokens` — fields OpenClaw does not emit.
 * A real OpenClaw line instead carries:
 *   message.usage = { input, output, cacheRead, cacheWrite, totalTokens,
 *                     cost: { input, output, cacheRead, cacheWrite, total } }
 * plus a header line `{ type:"session", id, timestamp, cwd }`. So we read the
 * NATIVE field names here for tokens/context, and sum `usage.cost.total` for the
 * native session cost. We still reuse `parseClaudeTranscript` for the parts that
 * ARE format-agnostic (they walk `message.content[]`): the tool set, model,
 * heuristic subject, and the Haiku recap input.
 */

/** Split text into parsed JSONL entries (skip bad lines). Pure, never throws. */
function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Read id/cwd/start off the `type:"session"` header line, if present. */
function headerOf(entries: any[]): { id?: string; cwd: string | null; startedAt: number | null } {
  const h = entries.find((e) => e?.type === "session");
  const ts = typeof h?.timestamp === "string" ? Date.parse(h.timestamp) : NaN;
  return {
    id: typeof h?.id === "string" ? h.id : undefined,
    cwd: typeof h?.cwd === "string" ? h.cwd : null,
    startedAt: Number.isNaN(ts) ? null : ts,
  };
}

/**
 * Pure transcript-text -> persisted-row conversion. Walks the OpenClaw-native
 * usage fields for tokens / per-hour cumulative sample points / MAX occupancy and
 * sums the native per-message cost. Reuses parseClaudeTranscript for the
 * content-array-derived bits (tools/model/subject). Never throws on garbage — a
 * file with no header and no parseable usage yields a minimal closed session with
 * no samples (mtime fallback) and an undefined cost.
 */
export function openclawToImport(
  text: string,
  meta: { sessionId: string; cwd: string | null; mtime: number },
): { session: PersistedSession; samples: SessionSample[]; events: PersistedEvent[] } {
  const entries = parseLines(text);
  const header = headerOf(entries);

  // parseClaudeTranscript gives us the format-agnostic content-array bits
  // (tools, model, subjectInput, summaryInput). Its token/context numbers are
  // wrong for openclaw's field names — we recompute those below and override.
  const base = parseClaudeTranscript(text);

  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCacheRead = 0;
  let tokensCacheWrite = 0;
  let costTotal = 0;
  let sawCost = false;
  let model: string | undefined = base.model;

  let firstTs: number | null = header.startedAt;
  let lastTs: number | null = null;
  const points: Point[] = [];

  for (const ev of entries) {
    if (ev?.type === "session") continue; // header, not a turn
    const ts = typeof ev?.timestamp === "string" ? Date.parse(ev.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (firstTs == null || ts < firstTs) firstTs = ts;
      if (lastTs == null || ts > lastTs) lastTs = ts;
    }
    const msg = ev?.message;
    if (typeof msg?.model === "string") model = msg.model;
    const usage = msg?.usage;
    if (!usage) continue;
    const fresh = usage.input ?? 0;
    const out = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    tokensIn += fresh;
    tokensOut += out;
    tokensCacheRead += cacheRead;
    tokensCacheWrite += cacheWrite;
    const turnCost = usage.cost?.total;
    if (typeof turnCost === "number") {
      costTotal += turnCost;
      sawCost = true;
    }
    const occupancy = fresh + out + cacheRead + cacheWrite; // this turn's working set
    if (Number.isNaN(ts)) continue; // can't bucket an untimestamped point
    points.push({
      at: ts,
      cost_usd: typeof turnCost === "number" ? turnCost : null,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      tokens_cache_read: tokensCacheRead,
      tokens_cache_write: tokensCacheWrite,
      context_tokens: occupancy,
      context_window: null,
      cpu: null,
      mem_mb: null,
      active: 0,
    });
  }

  const enr: BuildEnrichment = {
    model,
    subjectInput: base.subjectInput,
    tokensIn,
    tokensOut,
    tokensCacheRead,
    tokensCacheWrite,
    // last-turn occupancy fallback (peakOf(points) usually supersedes this).
    contextTokens: points.length ? points[points.length - 1].context_tokens : base.contextTokens,
    toolsUsed: base.toolsUsed,
  };

  const startedAt = firstTs ?? meta.mtime;
  const endedAt = lastTs ?? meta.mtime;

  return buildClosedSession({
    provider: "openclaw",
    // Prefer the header id; fall back to the filename-derived meta id.
    sessionKey: header.id ?? meta.sessionId,
    // OpenClaw sessions are resumable via the UUID.
    resumeId: header.id ?? meta.sessionId,
    cwd: header.cwd ?? meta.cwd,
    startedAt,
    endedAt,
    category: "personal", // openclaw provider default; orchestrator may refine via cwd rules
    enrichment: enr,
    points,
    errored: base.errored,
    // Native per-message cost summed; undefined when the file carried no cost.
    costUsd: sawCost ? costTotal : undefined,
  });
}

/** Role-tagged conversation tail for the Haiku enrichment phase. Reuses the recap
 * text parseClaudeTranscript assembles off the content array (format-agnostic). */
function openclawEnrichInput(text: string): string {
  return trimTail(parseClaudeTranscript(text).summaryInput);
}

/** Read id/cwd off the header line without a full parse (cheap discover prep). */
function headerFromFile(path: string): { id?: string; cwd: string | null } {
  try {
    return headerOf(parseLines(readFileSync(path, "utf8")));
  } catch {
    return { cwd: null };
  }
}

function agentsDirFor(home: string): string {
  return join(home, ".openclaw", "agents");
}

export const openclawBackfillAdapter: BackfillAdapter = {
  id: "openclaw",
  available(opts?: { home?: string }): boolean {
    const home = opts?.home ?? os.homedir();
    return existsSync(agentsDirFor(home));
  },
  *discover(opts: BackfillOpts): Iterable<RawSession> {
    const home = opts.home ?? os.homedir();
    const agentsDir = agentsDirFor(home);
    let agents: string[];
    try {
      agents = readdirSync(agentsDir);
    } catch {
      return;
    }
    for (const agent of agents) {
      const sessDir = join(agentsDir, agent, "sessions");
      let files: string[];
      try {
        files = readdirSync(sessDir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const path = join(sessDir, f);
        let mtime = 0;
        try {
          mtime = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        const head = headerFromFile(path);
        const raw: OpenClawRaw = {
          path,
          sessionId: head.id ?? f.replace(/\.jsonl$/, ""),
          cwd: head.cwd,
          mtime,
        };
        yield raw;
      }
    }
  },
  sessionKey(raw: RawSession): string {
    return (raw as OpenClawRaw).sessionId;
  },
  toImport(raw: RawSession) {
    const r = raw as OpenClawRaw;
    const text = readFileSync(r.path, "utf8");
    return openclawToImport(text, { sessionId: r.sessionId, cwd: r.cwd, mtime: r.mtime });
  },
  enrichInput(raw: RawSession): string {
    const r = raw as OpenClawRaw;
    try {
      return openclawEnrichInput(readFileSync(r.path, "utf8"));
    } catch {
      return "";
    }
  },
};
