import type { PersistedSession, SessionSample, PersistedEvent, SubSession } from "@mc/shared";
import type { BatchAnalyze } from "./enrich.ts";

export type RawSession = unknown;

export interface BackfillAdapter {
  id: string;
  available(opts?: { home?: string }): boolean;
  discover(opts: BackfillOpts): Iterable<RawSession> | AsyncIterable<RawSession>;
  sessionKey(raw: RawSession): string;
  toImport(raw: RawSession): {
    session: PersistedSession;
    samples?: SessionSample[];
    events?: PersistedEvent[];
  };
  /** Role-tagged conversation tail for the Haiku enrichment phase (optional). */
  enrichInput?(raw: RawSession): string;
  /** Per-subagent usage breakdown for a discovered session (optional; Claude only).
   * Used by the sub_sessions backfill phase to populate historical rows. */
  subSessions?(raw: RawSession): SubSession[];
}

export interface BackfillOpts {
  registry?: BackfillAdapter[];        // injectable for tests; defaults to REGISTRY
  providers?: string[];                // subset filter by adapter id
  includeHermesCron?: boolean;
  enrich?: boolean;                    // run phase 2 (default true if key present)
  enrichOnly?: boolean;                // skip import; run only the enrichment phase (BF10)
  dryRun?: boolean;
  batchSize?: number;
  analyze?: BatchAnalyze;              // injectable batch analyzer (tests); prod uses anthropicBatchAnalyze()
  home?: string;                       // override HOME for adapters (tests); default os.homedir()
}

export interface ProviderReport { imported: number; skipped: number; failed: boolean; reasons: string[]; }
export interface BackfillReport {
  providers: Record<string, ProviderReport>;
  enrich?: { enriched: number; degraded: number; skippedPhase: boolean };
  /** sub_sessions backfill phase: sessions that got a breakdown + rows written. */
  subSessions?: { sessions: number; rows: number };
}
