import type { AppConfig } from "@mc/shared";

const STALE_FLOOR_MS = 2000;

/** Defaults sourced from env (falls back to hardcoded). Pure: env passed in. */
export function defaultConfig(env: Record<string, string | undefined>): AppConfig {
  return {
    staleMs: Number(env.MC_STALE_MS || 10_000),
    categories: {},
    summaries: {
      enabled: env.MC_SUMMARIES !== "0",
      model: env.MC_SUMMARY_MODEL || "claude-haiku-4-5",
      minIntervalMs: Number(env.MC_SUMMARY_INTERVAL_MS || 60_000),
    },
    retention: {
      sampleIntervalMs: Number(env.MC_SAMPLE_INTERVAL_MS || 60_000),
      rawDays: Number(env.MC_RETAIN_RAW_DAYS || 15),
      hourDays: Number(env.MC_RETAIN_HOUR_DAYS || 90),
      eventDays: Number(env.MC_RETAIN_EVENT_DAYS || 90),
      maxBytes: Number(env.MC_RETAIN_MAX_BYTES || 500_000_000),
      compactIntervalMs: Number(env.MC_COMPACT_INTERVAL_MS || 3_600_000),
      orphanCloseDays: Number(env.MC_RETAIN_ORPHAN_CLOSE_DAYS || 7),
    },
    budgetUsd: Number(env.MC_BUDGET_USD || 0) || undefined,
    idleMinutes: Number(env.MC_IDLE_MINUTES || 0) || undefined,
  };
}

/** Overlay a (partial) persisted config over a base. */
export function mergeConfig(base: AppConfig, over: Partial<AppConfig>): AppConfig {
  return {
    staleMs: over.staleMs ?? base.staleMs,
    categories: over.categories ?? base.categories,
    summaries: { ...base.summaries, ...over.summaries },
    retention: over.retention ?? base.retention,
    budgetUsd: over.budgetUsd ?? base.budgetUsd,
    idleMinutes: over.idleMinutes ?? base.idleMinutes,
  };
}

/** Apply a UI patch with validation/clamping. Pure. */
export function applySettings(base: AppConfig, patch: Partial<AppConfig>): AppConfig {
  const merged = mergeConfig(base, patch);
  return { ...merged, staleMs: Math.max(STALE_FLOOR_MS, merged.staleMs) };
}
