import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { ProviderPlugin, Enrichment, EnrichContext } from "./types.ts";
import type { ProcInfo } from "../procscan.ts";

/** Hermes session row (subset) + its recent messages, chronological. */
export type HermesSession = {
  model?: string;
  title?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
};
export type HermesMessage = { role: string; content: unknown };

/** Pure: build enrichment from a hermes session row + recent messages. */
export function assembleHermes(s: HermesSession, messages: HermesMessage[]): Enrichment {
  const out: Enrichment = {
    tokensIn: s.input_tokens ?? 0,
    tokensCacheRead: s.cache_read_tokens ?? 0,
    tokensCacheWrite: s.cache_write_tokens ?? 0,
    tokensOut: s.output_tokens ?? 0,
  };
  if (s.model) out.model = s.model;
  if (s.title) out.summary = s.title;
  const convo = messages
    .filter((m) => typeof m.content === "string" && (m.content as string).trim())
    .map((m) => `${m.role}: ${m.content as string}`);
  if (convo.length) {
    out.summaryInput = convo.slice(-12).join("\n");
    const opening = convo.filter((c) => c.startsWith("user:")).slice(0, 3);
    if (opening.length) out.subjectInput = opening.join("\n").slice(0, 2000);
  }
  return out;
}

// Keep one readonly handle open across ticks (the DB can be large).
let cached: { path: string; db: Database } | null = null;
function openDb(path: string): Database | null {
  if (cached?.path === path) return cached.db;
  try {
    cached = { path, db: new Database(path, { readonly: true }) };
    return cached.db;
  } catch {
    return null;
  }
}

export const hermesPlugin: ProviderPlugin = {
  id: "hermes",
  defaultCategory: "personal",
  matchProcess(p: ProcInfo) {
    return /(^|[\s/])hermes([\s/_-]|$)/i.test(p.args) || p.comm === "hermes";
  },
  async enrich(_p, _cwd, ctx: EnrichContext): Promise<Enrichment> {
    // Hermes is a single gateway, not cwd-scoped — use the most recent session.
    const db = openDb(join(ctx.home, ".hermes", "state.db"));
    if (!db) return {};
    const s = db
      .query(
        "SELECT id, model, title, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens " +
          "FROM sessions ORDER BY started_at DESC LIMIT 1",
      )
      .get() as (HermesSession & { id: string }) | null;
    if (!s) return {};
    const rows = db
      .query(
        "SELECT role, content FROM messages WHERE session_id = ? " +
          "AND role IN ('user','assistant') ORDER BY rowid DESC LIMIT 12",
      )
      .all(s.id) as HermesMessage[];
    const out = assembleHermes(s, rows.reverse());
    const last = db
      .query("SELECT timestamp FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(s.id) as { timestamp?: unknown } | null;
    const ts = last?.timestamp;
    const ms = typeof ts === "number" ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(String(ts));
    if (Number.isFinite(ms)) out.lastActivityAt = ms;
    return out;
  },
};
