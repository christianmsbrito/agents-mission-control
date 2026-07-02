import { estimateCost, resolveCategory, compileCwdRules } from "@mc/shared";
import type { Store } from "../store.ts";
import type { BackfillAdapter, BackfillOpts, BackfillReport, ProviderReport, RawSession } from "./types.ts";
import { claudeBackfillAdapter } from "./adapters/claude.ts";
import { codexBackfillAdapter } from "./adapters/codex.ts";
import { hermesBackfillAdapter } from "./adapters/hermes.ts";
import { openclawBackfillAdapter } from "./adapters/openclaw.ts";
import { opencodeBackfillAdapter } from "./adapters/opencode.ts";
import { anthropicBatchAnalyze, enrichMissing } from "./enrich.ts";

/** Adapters register here in BF3-7. */
export const REGISTRY: BackfillAdapter[] = [
  claudeBackfillAdapter,
  codexBackfillAdapter,
  hermesBackfillAdapter,
  openclawBackfillAdapter,
  opencodeBackfillAdapter,
];

/**
 * Import historical sessions from each available adapter into the persistence
 * store, with nested graceful-degradation guards:
 *   - provider guard: a throwing discover()/loop isolates that adapter (failed=true)
 *     and the run continues with the next.
 *   - session guard: a throwing toImport()/sessionKey() for one item is tallied as
 *     skipped (with a reason) and the loop continues.
 * Skip-if-exists: a key already in the store is left untouched (live wins).
 * dryRun parses + tallies would-imports but writes nothing.
 */
export async function runBackfill(store: Store, opts: BackfillOpts = {}): Promise<BackfillReport> {
  const registry = opts.registry ?? REGISTRY;
  // No live AppConfig during backfill: compile empty rules. resolveCategory then
  // falls back to the category the adapter already set (providerDefault arg).
  const rules = compileCwdRules({});
  const report: BackfillReport = { providers: {} };
  // Tails (and heuristic subjects) for the phase-2 enrichment. Built for EVERY
  // discovered session — even ones skipped-as-existing — so enrichOnly / re-runs
  // can enrich previously-imported rows whose summary is still NULL.
  const tails = new Map<string, string>();
  const subjects = new Map<string, string>();

  for (const adapter of registry) {
    if (!adapter.available(opts)) continue;
    if (opts.providers && !opts.providers.includes(adapter.id)) continue;

    const pr: ProviderReport = { imported: 0, skipped: 0, failed: false, reasons: [] };
    report.providers[adapter.id] = pr;

    // Provider guard: discover + the whole loop.
    try {
      for await (const raw of adapter.discover(opts)) {
        // Session guard: one bad session never sinks the provider.
        try {
          const key = adapter.sessionKey(raw);

          // Collect the enrichment tail for EVERY discovered session (before any
          // skip short-circuit), so enrichOnly + re-runs can enrich existing
          // null-summary rows. Guarded: a throwing enrichInput just yields no tail.
          if (adapter.enrichInput) {
            try {
              const tail = adapter.enrichInput(raw);
              if (tail) tails.set(key, tail);
            } catch {
              /* no tail for this session → it degrades in phase 2 */
            }
          }

          // enrichOnly: skip the import write entirely (discover-for-tails only).
          if (opts.enrichOnly) continue;

          if (store.has(key)) {
            pr.skipped++;
            continue;
          }
          const { session, samples, events } = adapter.toImport(raw);
          if (session.subject) subjects.set(key, session.subject);

          // Best-effort cost fallback: only when not already set, a model is known,
          // and at least one token count is present. Guarded so it never throws.
          if (session.costUsd == null) {
            try {
              const est = estimateCost(
                session.model,
                session.tokensIn ?? 0,
                session.tokensOut ?? 0,
                session.tokensCacheRead ?? 0,
                session.tokensCacheWrite ?? 0,
              );
              if (est != null) session.costUsd = est;
            } catch {
              /* never let cost estimation sink an import */
            }
          }

          // Best-effort category refinement (no-op with empty rules: keeps the
          // adapter's own category via providerDefault fallback).
          try {
            session.category = resolveCategory(session.provider, session.cwd, session.category, rules);
          } catch {
            /* keep the adapter's category on any resolver hiccup */
          }

          if (opts.dryRun) {
            pr.imported++; // counted as would-import; no write
            continue;
          }

          const outcome = store.importSession(session, samples, events);
          if (outcome === "imported") pr.imported++;
          else pr.skipped++;
        } catch (err) {
          pr.skipped++;
          pr.reasons.push(err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      pr.failed = true;
      pr.reasons.push(err instanceof Error ? err.message : String(err));
      continue;
    }
  }

  // Phase 1.5 (sub_sessions). Populate the per-subagent breakdown for historical
  // sessions already in the store (from live reporting or this run's import) that
  // lack it — the info lives in on-disk agent-*.jsonl transcripts. Idempotent and
  // skips running sessions (the live reporter owns those).
  if (!opts.dryRun) {
    report.subSessions = runSubSessionsBackfill(store, registry, opts);
  }

  // Phase 2 (Haiku enrichment). Skipped in dryRun (no writes). An injected
  // `analyze` (tests) overrides the real Anthropic batch analyzer, which is null
  // without an API key → enrichMissing returns skippedPhase.
  if (opts.enrich !== false && !opts.dryRun) {
    const analyze = opts.analyze ?? anthropicBatchAnalyze();
    report.enrich = await enrichMissing(store, {
      tails,
      subjects,
      analyze,
      batchSize: opts.batchSize,
    });
  }

  return report;
}

/**
 * Populate `sub_sessions` for historical sessions from on-disk subagent
 * transcripts. For each adapter that exposes `subSessions`, re-walk its discovery
 * and, for any session that is already in the store, isn't running (the live
 * reporter owns those), and has no breakdown yet, build + upsert the breakdown.
 * Idempotent (`hasSubSessions` skip) and fully guarded — one bad session never
 * sinks the phase. Returns counts of sessions and rows written.
 */
export function runSubSessionsBackfill(
  store: Store,
  registry: BackfillAdapter[],
  opts: BackfillOpts = {},
): { sessions: number; rows: number } {
  let sessions = 0;
  let rows = 0;
  for (const adapter of registry) {
    if (!adapter.subSessions || !adapter.available(opts)) continue;
    if (opts.providers && !opts.providers.includes(adapter.id)) continue;
    let discovered: Iterable<RawSession> | AsyncIterable<RawSession>;
    try {
      discovered = adapter.discover(opts);
    } catch {
      continue; // provider guard
    }
    // subSessions adapters discover synchronously (claude); iterate as a plain
    // iterable. (AsyncIterable adapters simply don't implement subSessions.)
    for (const raw of discovered as Iterable<RawSession>) {
      try {
        const key = adapter.sessionKey(raw);
        if (!store.has(key)) continue; // only sessions we have a row for
        if (store.hasSubSessions(key)) continue; // idempotent
        if (store.sessionState(key) === "running") continue; // live owns it
        const subs = adapter.subSessions(raw);
        if (!subs.length) continue;
        store.upsertSubSessions(key, subs);
        sessions++;
        rows += subs.length;
      } catch {
        /* one bad session never sinks the phase */
      }
    }
  }
  return { sessions, rows };
}
