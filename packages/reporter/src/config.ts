import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { CategoryConfig } from "@mc/shared";

export type ReporterConfig = {
  serverUrl: string;
  token: string;
  hostId: string;
  hostLabel: string;
  home: string;
  intervalMs: number;
  /** Max age (ms) of a claude status file before its busy/shell `active` flag is treated as stale. */
  activeTtlMs: number;
  categories: CategoryConfig;
  /** LLM session recaps via Haiku. */
  summaries: { enabled: boolean; model: string; minIntervalMs: number };
};

/** Load config from env + optional ./mission-control.config.ts. */
export async function loadConfig(): Promise<ReporterConfig> {
  let categories: CategoryConfig = {};
  try {
    const mod: any = await import(join(process.cwd(), "mission-control.config.ts"));
    categories = mod.default?.categories ?? mod.categories ?? {};
  } catch {
    /* optional */
  }
  const label = process.env.MC_HOST_LABEL || hostname();
  return {
    serverUrl: process.env.MC_SERVER_URL || "ws://localhost:7777/ws/report",
    token: process.env.MC_TOKEN || "dev-token",
    hostId: process.env.MC_HOST_ID || label,
    hostLabel: label,
    home: process.env.MC_HOME || homedir(),
    intervalMs: Number(process.env.MC_INTERVAL_MS || 3000),
    activeTtlMs: Number(process.env.MC_ACTIVE_TTL_MS || 300_000),
    categories,
    summaries: {
      enabled: process.env.MC_SUMMARIES !== "0",
      model: process.env.MC_SUMMARY_MODEL || "claude-haiku-4-5",
      minIntervalMs: Number(process.env.MC_SUMMARY_INTERVAL_MS || 60_000),
    },
  };
}
