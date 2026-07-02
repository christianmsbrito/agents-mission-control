import { existsSync, readdirSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import os from "node:os";
import type { PersistedSession, SessionSample, PersistedEvent } from "@mc/shared";
import {
  parseClaudeTranscript,
  addSubagentUsage,
  type SubagentUsage,
} from "../../../../reporter/src/providers/claude.ts";
import type { BackfillAdapter, BackfillOpts, RawSession } from "../types.ts";
import { buildClosedSession, trimTail, type Point } from "./_common.ts";

/** One discovered claude transcript on disk. */
type ClaudeRaw = { path: string; sessionId: string; cwd: string | null; mtime: number };

/** Parse the transcript text into deduped JSONL entries (keep LAST per message.id),
 * mirroring parseClaudeTranscript so sample points and aggregates stay aligned. */
function dedupedEntries(text: string): any[] {
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
  return parsed.filter((ev, i) => {
    const id = ev?.message?.id;
    return typeof id !== "string" || lastIdx.get(id) === i;
  });
}

/**
 * Pure transcript -> persisted-row conversion. Reuses parseClaudeTranscript for
 * the token/tool/model/context aggregates (no duplicate aggregation), and walks
 * the deduped entries itself for the timeline (startedAt/endedAt) and the
 * cumulative per-hour sample points. Never throws on garbage input — a transcript
 * with no parseable timestamped usage yields a minimal closed session with no
 * samples (falling back to mtime for the timeline).
 */
export function claudeToImport(
  text: string,
  meta: { sessionId: string; cwd: string | null; mtime: number },
  subagentTexts: string[] = [],
): { session: PersistedSession; samples: SessionSample[]; events: PersistedEvent[] } {
  const enr = parseClaudeTranscript(text);
  const entries = dedupedEntries(text);

  // Fold subagent transcript tokens into the rollup (see reporter's foldSubagents):
  // a subagent-driven session logs most of its cost to sibling agent-*.jsonl files.
  // The per-hour sample timeline stays main-only (the closed-session cost rollup is
  // what matters for history; interleaving subagent turns by time isn't worth it).
  for (const sub of subagentTexts) {
    const s = parseClaudeTranscript(sub);
    const u: SubagentUsage = {
      tokensIn: s.tokensIn ?? 0,
      tokensOut: s.tokensOut ?? 0,
      tokensCacheRead: s.tokensCacheRead ?? 0,
      tokensCacheWrite: s.tokensCacheWrite ?? 0,
    };
    addSubagentUsage(enr, u);
  }

  let firstTs: number | null = null;
  let lastTs: number | null = null;
  const points: Point[] = [];
  // Running cumulative totals as we walk the transcript in order.
  let cumIn = 0;
  let cumOut = 0;
  let cumCacheRead = 0;
  let cumCacheWrite = 0;

  for (const ev of entries) {
    const ts = typeof ev?.timestamp === "string" ? Date.parse(ev.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (firstTs == null || ts < firstTs) firstTs = ts;
      if (lastTs == null || ts > lastTs) lastTs = ts;
    }
    // Error turns carry no usage; matching parseClaudeTranscript, skip them.
    if (ev?.isApiErrorMessage === true) continue;
    const usage = ev?.message?.usage;
    if (!usage) continue;
    const fresh = usage.input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const out = usage.output_tokens ?? 0;
    cumIn += fresh;
    cumOut += out;
    cumCacheRead += cacheRead;
    cumCacheWrite += cacheWrite;
    const occupancy = fresh + cacheWrite + cacheRead + out; // this turn's occupancy
    if (Number.isNaN(ts)) continue; // can't place an untimestamped point in a bucket
    points.push({
      at: ts,
      cost_usd: null,
      tokens_in: cumIn,
      tokens_out: cumOut,
      tokens_cache_read: cumCacheRead,
      tokens_cache_write: cumCacheWrite,
      context_tokens: occupancy,
      context_window: null,
      cpu: null,
      mem_mb: null,
      active: 0,
    });
  }

  const startedAt = firstTs ?? meta.mtime;
  const endedAt = lastTs ?? meta.mtime;

  return buildClosedSession({
    provider: "claude",
    sessionKey: meta.sessionId,
    resumeId: meta.sessionId,
    cwd: meta.cwd,
    startedAt,
    endedAt,
    category: "code", // provider default; orchestrator may refine via cwd rules
    enrichment: enr,
    points,
    errored: enr.errored,
  });
}

/** Role-tagged conversation tail for the Haiku enrichment phase. Reuses the
 * recap text parseClaudeTranscript already assembles (summaryInput), trimmed. */
function claudeEnrichInput(text: string): string {
  return trimTail(parseClaudeTranscript(text).summaryInput);
}

/** Read the cwd off the first transcript line that carries one (accurate; the
 * encoded projects/ dir name is lossy and not round-trippable). */
function cwdFromTranscript(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const ev = JSON.parse(t);
        if (typeof ev?.cwd === "string") return ev.cwd;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* unreadable */
  }
  return null;
}

/** Read this session's subagent transcripts from `<projectDir>/<sessionId>/subagents/`.
 * Best-effort: a missing dir (older Claude / none spawned) or an unreadable file
 * yields fewer texts, never throws. */
function readSubagentTexts(projectDir: string, sessionId: string): string[] {
  const subDir = join(projectDir, sessionId, "subagents");
  let names: string[];
  try {
    names = readdirSync(subDir);
  } catch {
    return [];
  }
  const texts: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      texts.push(readFileSync(join(subDir, name), "utf8"));
    } catch {
      /* skip unreadable */
    }
  }
  return texts;
}

export const claudeBackfillAdapter: BackfillAdapter = {
  id: "claude",
  available(opts?: { home?: string }): boolean {
    return existsSync(join(opts?.home ?? os.homedir(), ".claude", "projects"));
  },
  *discover(opts: BackfillOpts): Iterable<RawSession> {
    const home = opts.home ?? os.homedir();
    const root = join(home, ".claude", "projects");
    let dirs: string[];
    try {
      dirs = readdirSync(root);
    } catch {
      return;
    }
    for (const dir of dirs) {
      const dirPath = join(root, dir);
      let files: string[];
      try {
        files = readdirSync(dirPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const path = join(dirPath, f);
        let mtime = 0;
        try {
          mtime = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        const raw: ClaudeRaw = {
          path,
          sessionId: basename(f, ".jsonl"),
          cwd: cwdFromTranscript(path),
          mtime,
        };
        yield raw;
      }
    }
  },
  sessionKey(raw: RawSession): string {
    return (raw as ClaudeRaw).sessionId;
  },
  toImport(raw: RawSession) {
    const r = raw as ClaudeRaw;
    const text = readFileSync(r.path, "utf8");
    return claudeToImport(
      text,
      { sessionId: r.sessionId, cwd: r.cwd, mtime: r.mtime },
      readSubagentTexts(dirname(r.path), r.sessionId),
    );
  },
  enrichInput(raw: RawSession): string {
    const r = raw as ClaudeRaw;
    try {
      return claudeEnrichInput(readFileSync(r.path, "utf8"));
    } catch {
      return "";
    }
  },
};
