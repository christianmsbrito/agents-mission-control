import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderPlugin, Enrichment, EnrichContext } from "./types.ts";
import type { ProcInfo } from "../procscan.ts";
import { extractClis, commandFromInput } from "../clis.ts";

/**
 * Parse a Codex rollout JSONL (`~/.codex/sessions/.../rollout-*.jsonl`).
 * Lines are `{timestamp, type, payload}`; we switch on `payload.type`.
 */
export function parseCodexRollout(text: string): Enrichment {
  let model: string | undefined;
  let summary: string | undefined;
  let lastUsage: any;
  let lastTurn: any; // per-turn usage = live context occupancy
  let ctxWindow: number | undefined; // codex reports its own window
  const tools = new Set<string>();
  const convo: string[] = [];

  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    const p = ev.payload ?? ev;
    switch (p?.type) {
      case "token_count":
        if (p.info?.total_token_usage) lastUsage = p.info.total_token_usage;
        if (p.info?.last_token_usage) lastTurn = p.info.last_token_usage;
        if (typeof p.info?.model_context_window === "number") ctxWindow = p.info.model_context_window;
        break;
      case "user_message":
        if (typeof p.message === "string") {
          convo.push(`user: ${p.message}`);
          summary ??= p.message.slice(0, 140);
        }
        break;
      case "agent_message":
        if (typeof p.message === "string") {
          convo.push(`assistant: ${p.message}`);
          summary = p.message.slice(0, 140);
        }
        break;
      case "function_call":
        if (typeof p.name === "string") {
          tools.add(p.name);
          // exec_command/shell carry the command in a JSON-string `arguments`.
          if (/exec|shell|bash/i.test(p.name) && typeof p.arguments === "string") {
            try {
              const cmd = commandFromInput(JSON.parse(p.arguments));
              if (cmd) for (const cli of extractClis(cmd)) tools.add(`$${cli}`);
            } catch {
              /* ignore */
            }
          }
        }
        break;
    }
    if (!model && typeof p?.model === "string") model = p.model;
  }

  const out: Enrichment = {};
  if (lastUsage) {
    const cached = lastUsage.cached_input_tokens ?? 0;
    out.tokensIn = Math.max(0, (lastUsage.input_tokens ?? 0) - cached);
    out.tokensCacheRead = cached;
    out.tokensOut = lastUsage.output_tokens ?? 0;
  }
  if (lastTurn) {
    // last_token_usage.input_tokens already includes the cached portion, so
    // total_tokens is the full working set the model held this turn.
    out.contextTokens =
      lastTurn.total_tokens ?? (lastTurn.input_tokens ?? 0) + (lastTurn.output_tokens ?? 0);
  }
  if (ctxWindow) out.contextWindow = ctxWindow;
  if (model) out.model = model;
  if (summary) out.summary = summary;
  if (tools.size) out.toolsUsed = [...tools];
  if (convo.length) {
    out.summaryInput = convo.slice(-12).join("\n");
    const opening = convo.filter((c) => c.startsWith("user:")).slice(0, 3);
    if (opening.length) out.subjectInput = opening.join("\n").slice(0, 2000);
  }
  return out;
}

/**
 * Parse just the first line (the session_meta) without reading the whole file.
 * The meta line can be tens of KB (it embeds base_instructions), so stream
 * until the first newline rather than slicing a fixed head.
 */
async function firstLine(path: string): Promise<any | null> {
  try {
    const reader = Bun.file(path).stream().getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        await reader.cancel();
        return JSON.parse(buf.slice(0, nl));
      }
      if (done) break;
      if (buf.length > 2_000_000) {
        await reader.cancel();
        return null;
      }
    }
    return buf.trim() ? JSON.parse(buf) : null;
  } catch {
    return null;
  }
}

/** Newest rollout file whose session_meta.cwd matches `cwd`. */
async function findRollout(home: string, cwd: string | null): Promise<string | null> {
  if (!cwd) return null;
  const base = join(home, ".codex", "sessions");
  let entries: string[];
  try {
    entries = await readdir(base, { recursive: true });
  } catch {
    return null;
  }
  const files: { path: string; mtime: number }[] = [];
  for (const e of entries) {
    if (!e.endsWith(".jsonl") || !e.includes("rollout-")) continue;
    const p = join(base, e);
    try {
      files.push({ path: p, mtime: (await stat(p)).mtimeMs });
    } catch {
      /* skip */
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(0, 40)) {
    const meta = await firstLine(f.path);
    if (meta?.payload?.cwd === cwd || meta?.cwd === cwd) return f.path;
  }
  return null;
}

/**
 * Live state written by the mc-codex hook (codex persists no status of its own,
 * unlike claude's `status`). `attention` blocks on the user; `active` is the
 * authoritative processing flag. `active` is only honored when the field is
 * present — state files from an older hook lack it, so the reporter falls back
 * to the rollout-mtime heuristic rather than pinning the session idle.
 */
type CodexState = { active?: boolean; attention: boolean };

async function stateFor(home: string, sessionId: string | null, cwd: string | null): Promise<CodexState> {
  const dir = join(home, ".mission-control", "codex");
  const fresh = (s: any): boolean => (s?.at ?? 0) > Date.now() - 6 * 3600_000; // ignore >6h stale
  const pick = (s: any): CodexState => {
    const out: CodexState = { attention: s?.attention === true };
    if (typeof s?.active === "boolean") out.active = s.active;
    return out;
  };
  if (sessionId) {
    try {
      const s = JSON.parse(await Bun.file(join(dir, `${sessionId}.json`)).text());
      if (fresh(s)) return pick(s);
    } catch {
      /* fall through to cwd scan */
    }
  }
  if (!cwd) return { attention: false };
  try {
    const { readdir } = await import("node:fs/promises");
    let best: { at: number; state: CodexState } | null = null; // newest matching-cwd state wins
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      const s = JSON.parse(await Bun.file(join(dir, f)).text());
      if (s?.cwd === cwd && fresh(s) && (!best || (s.at ?? 0) > best.at)) {
        best = { at: s.at ?? 0, state: pick(s) };
      }
    }
    if (best) return best.state;
  } catch {
    /* no state dir */
  }
  return { attention: false };
}

// Per-tick caches. Codex rarely holds its rollout open, so the fallback lookup
// (a recursive scan of ~/.codex/sessions plus first-line reads) used to run for
// every codex process every tick, followed by a full re-parse of the rollout.
const ROLLOUT_LOOKUP_TTL_MS = 30_000; // a new session in the same cwd shows up within this
const CACHE_IDLE_MS = 60_000;
const rolloutByPid = new Map<number, { path: string | null; resolvedAt: number; seenAt: number }>();
const parseCache = new Map<string, { key: string; parsed: Enrichment; seenAt: number }>();

function evictIdle(now: number): void {
  for (const [k, v] of rolloutByPid) if (now - v.seenAt > CACHE_IDLE_MS) rolloutByPid.delete(k);
  for (const [k, v] of parseCache) if (now - v.seenAt > CACHE_IDLE_MS) parseCache.delete(k);
}

async function cachedFindRollout(pid: number, home: string, cwd: string | null, now: number): Promise<string | null> {
  const hit = rolloutByPid.get(pid);
  if (hit && now - hit.resolvedAt < ROLLOUT_LOOKUP_TTL_MS) {
    hit.seenAt = now;
    return hit.path;
  }
  // misses are cached too: a codex process with no rollout (e.g. the ChatGPT app's
  // embedded one) would otherwise rescan every tick
  const path = await findRollout(home, cwd);
  rolloutByPid.set(pid, { path, resolvedAt: now, seenAt: now });
  return path;
}

export const codexPlugin: ProviderPlugin = {
  id: "codex",
  defaultCategory: "review",
  needsOpenFiles: true, // finds its rollout file via lsof
  matchProcess(p: ProcInfo) {
    return /(^|\/)codex(\s|$)/.test(p.args) || p.comm === "codex";
  },
  async enrich(p, cwd, ctx: EnrichContext): Promise<Enrichment> {
    const now = ctx.now ?? Date.now();
    evictIdle(now);
    // Prefer the rollout the process has open (exact, disambiguates same-cwd).
    const open = ctx.openFiles.find((f) => /rollout-.*\.jsonl$/.test(f) && f.includes(".codex"));
    let file = open ?? (await cachedFindRollout(p.pid, ctx.home, cwd, now));
    if (!file) return {};
    let st = await stat(file).catch(() => null);
    if (!st && !open) {
      // a cached path that vanished (rollout moved/removed): resolve afresh once
      rolloutByPid.delete(p.pid);
      file = await cachedFindRollout(p.pid, ctx.home, cwd, now);
      st = file ? await stat(file).catch(() => null) : null;
    }
    if (!file || !st) return {};
    // Re-parse only when the rollout changed; copy, since the fields below mutate it.
    const key = `${st.mtimeMs}:${st.size}`;
    let ent = parseCache.get(file);
    if (!ent || ent.key !== key) {
      ent = { key, parsed: parseCodexRollout(await Bun.file(file).text()), seenAt: now };
      parseCache.set(file, ent);
    }
    ent.seenAt = now;
    const out: Enrichment = { ...ent.parsed };
    out.lastActivityAt = st.mtimeMs;
    // session id is the uuid embedded in rollout-<ts>-<uuid>.jsonl
    const sid = file.match(/([0-9a-f]{8}-[0-9a-f-]+)\.jsonl$/)?.[1] ?? null;
    if (sid) out.providerSessionId = sid;
    const state = await stateFor(ctx.home, sid, cwd);
    if (state.attention) out.attention = true;
    // Authoritative when the hook reports it; otherwise leave undefined so the
    // web infers from rollout mtime (sessionActive in App.tsx).
    if (state.active !== undefined) out.active = state.active;
    return out;
  },
};
