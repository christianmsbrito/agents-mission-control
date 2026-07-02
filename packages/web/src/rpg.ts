// The semantic bridge: agent-session data -> RPG character stats. Pure functions,
// no React, no DOM — so the metaphor is testable and theme-agnostic. Themes style
// these; they don't redefine them.
import type { Session, PersistedSession, SubSession } from "@mc/shared";

/** The VISUAL identity of a provider's class — sigil + portrait hue. The class
 * NAME (job) is theme-dependent and lives in the lexicon (lex.jobs), not here. */
export type CharClass = { sigil: string; hue: number };

const CLASSES: Record<string, CharClass> = {
  claude: { sigil: "✦", hue: 265 },
  codex: { sigil: "✚", hue: 210 },
  opencode: { sigil: "➶", hue: 140 },
  pi: { sigil: "❉", hue: 45 },
  hermes: { sigil: "♪", hue: 320 },
  openclaw: { sigil: "⚒", hue: 10 },
};
const NEUTRAL: CharClass = { sigil: "◆", hue: 200 };

export function classOf(provider: string): CharClass {
  return CLASSES[provider] ?? NEUTRAL;
}

/** Total tokens consumed. NOT the main XP driver (see deedsOf) — kept for display
 * and as a small damped factor in progression. */
export function totalTokens(s: {
  tokensIn?: number; tokensOut?: number; tokensCacheRead?: number; tokensCacheWrite?: number;
}): number {
  return (s.tokensIn ?? 0) + (s.tokensOut ?? 0) + (s.tokensCacheRead ?? 0) + (s.tokensCacheWrite ?? 0);
}
/** @deprecated alias kept for callers that still display token totals. */
export const xpOf = totalTokens;

const TOOL_XP = 12; // each distinct tool ("skill learned") is worth this much XP
const QUEST_XP = 8; // each work item the agent has taken on
const TOKEN_XP_PER = 250_000; // tokens are a MINOR factor: 1 XP per 250k tokens

/** Experience earned. Driven mainly by activity — breadth of tools used and
 * quests taken on (the agent interacting with the world/human) — with raw token
 * volume only a small damped contribution. Grows visibly as an agent does things,
 * not just as it burns context. */
export function xpEarned(s: {
  toolsUsed?: string[];
  workItems?: { status?: string }[];
  tokensIn?: number; tokensOut?: number; tokensCacheRead?: number; tokensCacheWrite?: number;
}): number {
  const tools = (s.toolsUsed?.length ?? 0) * TOOL_XP;
  const quests = (s.workItems?.length ?? 0) * QUEST_XP;
  const tokenBonus = Math.floor(totalTokens(s) / TOKEN_XP_PER); // minor
  return tools + quests + tokenBonus;
}

const XP_PER_LEVEL = 20; // a level every ~1.7 new tools; tokens nudge it along

/** Level from earned XP. Lv.1 at zero, climbing as the agent gathers skills/quests. */
export function levelOf(s: Parameters<typeof xpEarned>[0]): number {
  return Math.max(1, 1 + Math.floor(xpEarned(s) / XP_PER_LEVEL));
}

/** Progress toward the next level, 0..1 — drives the XP bar fill. */
export function levelProgress(s: Parameters<typeof xpEarned>[0]): number {
  return (xpEarned(s) % XP_PER_LEVEL) / XP_PER_LEVEL;
}

/** HP = remaining context headroom (1 = empty context/healthy, 0 = at the window
 * limit/about to compact). Undefined window => unknown, render as full. */
export function hpOf(contextTokens?: number, contextWindow?: number): number {
  if (!contextWindow || contextTokens == null) return 1;
  return Math.min(1, Math.max(0, 1 - contextTokens / contextWindow));
}

/** Battle state — the single most important visual signal on a card. */
export type BattleState = "ko" | "awaiting" | "battle" | "resting";

export function battleStateOf(s: {
  errored?: boolean; attention?: boolean; active?: boolean;
}): BattleState {
  if (s.errored) return "ko";
  if (s.attention) return "awaiting";
  if (s.active) return "battle";
  return "resting";
}

/** Classify a crash reason into a suggested-action KEY (the lexicon supplies the
 * themed action string under lex.crash[key]). Pure + honest: only returns a
 * specific kind when the signal is present in the text, else "generic". */
export type CrashAction = "reauth" | "model" | "transient" | "connection" | "context" | "generic";

export function classifyCrash(reason?: string, transient?: boolean): CrashAction {
  const t = reason ?? "";
  if (/401|invalid auth|run \/login|\/login/i.test(t)) return "reauth";
  if (/issue with the selected model|selected model|\/model/i.test(t)) return "model";
  if (/context (length|window)|too long|compact/i.test(t)) return "context";
  if (/idle timeout|connection (closed|refused|reset)|unable to connect|stream/i.test(t)) return "connection";
  if (transient || /overloaded|temporarily unavailable|server-side|try again|\b(429|500|502|503|504|529)\b/i.test(t))
    return "transient";
  return "generic";
}

// Battle/fate LABELS are theme-dependent — see lex.state / lex.fate. The state
// KEYS below are the stable mapping; the lexicon supplies the words.
/** Persisted (history) sessions are fallen/retired party members. */
export type FateState = "running" | "closed" | "orphaned";

/** A short display name for a character: Haiku nickname > handle > #pid. */
export function charName(s: { displayName?: string; handle?: string; pid?: number }): string {
  if (s.displayName) return s.displayName;
  if (s.handle) return s.handle;
  return `#${s.pid ?? "?"}`;
}

/** The persistence key for a live session (mirrors the server's sessionKeyOf):
 * provider-native id when present, else synthetic host:pid:startedAt. */
export function liveKey(s: { providerSessionId?: string; hostId: string; pid: number; startedAt: number }): string {
  return s.providerSessionId || `${s.hostId}:${s.pid}:${s.startedAt}`;
}

/** Format gold (cost) the FF way: integer gil. <1 cent rounds to a tiny purse. */
export function gold(usd?: number): string {
  if (usd == null) return "0";
  return Math.round(usd * 100).toLocaleString(); // cents == "gil", readable integers
}

/** The main-vs-total split for a session with in-process subagents. The session's
 * own totals ARE the true total (main + all subagents, per the cost fix); main-only
 * is total − Σ subSessions. `subPct` is the subagents' share of the total cost.
 * Clamped to ≥0 so a rounding/parse skew never renders a negative "main". */
export function subSplit(s: {
  costUsd?: number;
  subSessions?: SubSession[];
}): { subCount: number; subCost: number; mainCost: number; subPct: number } {
  const subs = s.subSessions ?? [];
  const total = s.costUsd ?? 0;
  const subCost = subs.reduce((a, x) => a + (x.costUsd ?? 0), 0);
  const mainCost = Math.max(0, total - subCost);
  const subPct = total > 0 ? Math.round((subCost / total) * 100) : 0;
  return { subCount: subs.length, subCost, mainCost, subPct };
}

/** Total tokens across a subagent's four token buckets (for its list row). */
export function subTokens(x: SubSession): number {
  return (x.tokensIn ?? 0) + (x.tokensOut ?? 0) + (x.tokensCacheRead ?? 0) + (x.tokensCacheWrite ?? 0);
}

/** Active fraction (0..1) of a persisted session's lifespan: activeMs / lifespan,
 * where lifespan = (endedAt ?? lastSeenAt) − startedAt. Undefined when activeMs is
 * absent (never sampled / feature not yet populated) or the lifespan is non-positive. */
export function activeFraction(s: {
  activeMs?: number;
  startedAt: number;
  endedAt?: number;
  lastSeenAt?: number;
}): number | undefined {
  if (s.activeMs == null) return undefined;
  const end = s.endedAt ?? s.lastSeenAt;
  if (end == null) return undefined;
  const lifespan = end - s.startedAt;
  if (lifespan <= 0) return undefined;
  return Math.min(1, Math.max(0, s.activeMs / lifespan));
}
