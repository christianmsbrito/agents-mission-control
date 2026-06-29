import os from "node:os";
import type { PersistedSession, SessionSample, PersistedEvent } from "@mc/shared";
import type { Enrichment } from "../../../../reporter/src/providers/types.ts";
import { hourBucket, condenseSamples } from "../../store.ts";

/** The host identity stamped on every backfilled row. Shared by all adapters. */
export const HOST_ID = os.hostname();

/**
 * A finer-than-hour sample point walked off a transcript/rollout before
 * condensing. Each adapter's provider-specific walk produces these; the shared
 * helpers below turn them into hour-bucketed `SessionSample` rows. The shape
 * matches `condenseSamples`'s `Sampleish` so points feed straight in.
 */
export type Point = {
  at: number;
  cost_usd: number | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  context_tokens: number;
  context_window: number | null;
  cpu: number | null;
  mem_mb: number | null;
  active: number;
};

/** Cap a heuristic subject string to `n` chars (default 200). Pure. */
export function truncate(s: string | undefined, n = 200): string | undefined {
  if (!s) return undefined;
  return s.length > n ? s.slice(0, n) : s;
}

/** Trim a conversation tail to its last `n` chars (default 2000) for the Haiku
 * enrichment phase. Pure. */
export function trimTail(s: string | undefined, n = 2000): string {
  const tail = s ?? "";
  return tail.length > n ? tail.slice(-n) : tail;
}

/** MAX per-point context occupancy across the walk (tracks compaction), or
 * undefined when there are no points (callers fall back to enr.contextTokens).
 * Pure. */
export function peakOf(points: Point[]): number | undefined {
  if (points.length === 0) return undefined;
  let peak = 0;
  for (const p of points) if (p.context_tokens > peak) peak = p.context_tokens;
  return peak;
}

/** Group points by hour bucket, sort buckets ascending, and condense each into a
 * single cumulative `resolution: "hour"` SessionSample. Pure. */
export function pointsToSamples(points: Point[], sessionKey: string): SessionSample[] {
  const byBucket = new Map<number, Point[]>();
  for (const p of points) {
    const b = hourBucket(p.at);
    let arr = byBucket.get(b);
    if (!arr) byBucket.set(b, (arr = []));
    arr.push(p);
  }
  const samples: SessionSample[] = [];
  for (const [bucketStart, rows] of [...byBucket.entries()].sort((a, b) => a[0] - b[0])) {
    const c = condenseSamples(rows);
    samples.push({
      sessionKey,
      at: bucketStart,
      resolution: "hour",
      tokensIn: c.tokens_in ?? undefined,
      tokensOut: c.tokens_out ?? undefined,
      tokensCacheRead: c.tokens_cache_read ?? undefined,
      tokensCacheWrite: c.tokens_cache_write ?? undefined,
      costUsd: c.cost_usd ?? undefined,
      contextTokens: c.context_tokens ?? undefined,
      contextWindow: c.context_window ?? undefined,
      cpu: c.cpu ?? undefined,
      memMb: c.mem_mb ?? undefined,
      active: c.active,
    });
  }
  return samples;
}

/** The aggregate enrichment a provider parser produces, as the builder consumes
 * it: a Pick of the reporter's Enrichment so an upstream field rename (e.g.
 * subjectInput) is a compile error here, not a silent stop-populating. */
export type BuildEnrichment = Pick<
  Enrichment,
  | "model"
  | "subjectInput"
  | "tokensIn"
  | "tokensOut"
  | "tokensCacheRead"
  | "tokensCacheWrite"
  | "contextTokens"
  | "toolsUsed"
>;

export interface BuildClosedSessionArgs {
  provider: string;
  sessionKey: string;
  resumeId: string | undefined;
  cwd: string | null;
  startedAt: number;
  endedAt: number;
  category: string; // provider default; orchestrator may refine via cwd rules
  enrichment: BuildEnrichment;
  points: Point[];
  /** Claude emits a session.errored bookend when the transcript errored; codex
   * has no such signal and omits this. */
  errored?: boolean;
  /** Provider-native cost when the format carries one (e.g. openclaw sums a
   * per-message `usage.cost.total`). When provided, it lands on `session.costUsd`
   * and the orchestrator's price-table estimate is skipped. Omitted by adapters
   * with no native cost (claude/codex/hermes), leaving costUsd undefined. */
  costUsd?: number;
}

/**
 * Assemble the closed `PersistedSession` + its hour-bucketed samples + lifecycle
 * events from a provider-specific walk. The single shared place all the
 * backfill-row boilerplate lives: heuristic subject, null summary (BF10 fills
 * it), MAX-occupancy peak, host identity, token rollups, and the
 * started/tool(s)/errored?/closed event bookends.
 *
 * Refuses an empty `sessionKey` (throws): an unkeyed row would collide on the
 * registry primary key. The orchestrator's per-session guard turns that throw
 * into a counted skip, so a meta-less rollout never imports a `sessionKey:""`
 * row.
 *
 * `points: []` is a first-class no-samples case: a provider with no per-turn
 * timestamps (e.g. hermes/opencode) passes an empty array, yielding `samples: []`
 * and `peakContextTokens` falling back to `enrichment.contextTokens` (or undefined).
 */
export function buildClosedSession(
  args: BuildClosedSessionArgs,
): { session: PersistedSession; samples: SessionSample[]; events: PersistedEvent[] } {
  const { provider, sessionKey, resumeId, cwd, startedAt, endedAt, category, enrichment: enr, points, errored, costUsd } = args;
  if (!sessionKey) {
    throw new Error(`${provider} backfill: no session id resolvable; skipping unkeyed session`);
  }

  const samples = pointsToSamples(points, sessionKey);

  const session: PersistedSession = {
    sessionKey,
    liveId: `${HOST_ID}:0`,
    resumeId,
    provider,
    hostId: HOST_ID,
    hostLabel: HOST_ID,
    cwd,
    category,
    model: enr.model,
    // Heuristic subject from opening prompts; summary is left undefined on
    // purpose so BF10's Haiku phase (WHERE summary IS NULL) fills it later.
    subject: truncate(enr.subjectInput),
    startedAt,
    endedAt,
    state: "closed",
    lastSeenAt: endedAt,
    // Provider-native cost when given (openclaw); otherwise left undefined so the
    // orchestrator estimates from the price table.
    costUsd,
    tokensIn: enr.tokensIn,
    tokensOut: enr.tokensOut,
    tokensCacheRead: enr.tokensCacheRead,
    tokensCacheWrite: enr.tokensCacheWrite,
    // MAX occupancy over the walk (not enr.contextTokens, which is just the last
    // turn's — a compacted session would otherwise report a too-low peak).
    peakContextTokens: peakOf(points) ?? enr.contextTokens,
    toolsUsed: enr.toolsUsed,
  };

  const events: PersistedEvent[] = [];
  events.push({ at: startedAt, sessionKey, type: "session.started", hostId: HOST_ID });
  // All session.tool events are stamped at startedAt: backfill has no reliable
  // per-tool timestamp (the parser only surfaces the tool set, not when each was
  // used). Deliberate simplification shared by all adapters.
  for (const tool of enr.toolsUsed ?? []) {
    events.push({ at: startedAt, sessionKey, type: "session.tool", hostId: HOST_ID, detail: { tool } });
  }
  if (errored) {
    events.push({ at: endedAt, sessionKey, type: "session.errored", hostId: HOST_ID });
  }
  events.push({ at: endedAt, sessionKey, type: "session.closed", hostId: HOST_ID });

  return { session, samples, events };
}
