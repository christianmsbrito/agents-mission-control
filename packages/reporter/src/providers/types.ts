import type { Session } from "@mc/shared";
import type { ProcInfo } from "../procscan.ts";

/** Context handed to plugins; `home` is injectable for tests. */
export type EnrichContext = {
  home: string;
  /** Epoch ms the process started (for matching same-cwd sessions by start time). */
  startedAt: number;
  /** Regular files the process currently has open (from lsof). */
  openFiles: string[];
  /** Current clock (epoch ms). Defaults to Date.now() when omitted (tests). */
  now?: number;
  /** Max age (ms) before a live-status `active` flag is treated as stale. */
  activeTtlMs?: number;
};

/** Subset of Session a plugin can fill in from session files. */
export type Enrichment = Partial<
  Pick<
    Session,
    | "model"
    | "providerSessionId"
    | "summary"
    | "tokensIn"
    | "tokensCacheRead"
    | "tokensCacheWrite"
    | "tokensOut"
    | "contextTokens"
    | "contextWindow"
    | "toolsUsed"
    | "workItems"
    | "lastActivityAt"
    | "active"
    | "attention"
    | "errored"
    | "errorTransient"
    | "errorAt"
    | "crashReason"
    | "costUsd"
  >
> & {
  /** Recent conversation text for the LLM recap — not stored on Session. */
  summaryInput?: string;
  /** The session's opening user prompts, for the broad subject — not stored on Session. */
  subjectInput?: string;
};

export interface ProviderPlugin {
  id: string;
  /** Role applied when config doesn't override. */
  defaultCategory: string;
  /** Is this process one of mine? */
  matchProcess(p: ProcInfo): boolean;
  /** Best-effort read of the live session file. Never throws to caller. */
  enrich?(p: ProcInfo, cwd: string | null, ctx: EnrichContext): Promise<Enrichment>;
}
