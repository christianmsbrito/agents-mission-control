import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { PersistedSession, SessionSample, PersistedEvent } from "@mc/shared";
import { assembleOpencode, type OcMessage } from "../../../../reporter/src/providers/opencode.ts";
import type { BackfillAdapter, BackfillOpts, RawSession } from "../types.ts";
import { buildClosedSession, trimTail, type Point, type BuildEnrichment } from "./_common.ts";

/**
 * An opencode `session/<projectID>/<id>.json` row (the fields the backfill reads).
 * `time.created`/`time.updated` are already epoch MILLISECONDS. `directory` is the
 * session cwd; `title` is a best-effort human label.
 */
export type OcSessionRow = {
  id: string;
  directory?: string;
  title?: string;
  time?: { created?: number; updated?: number };
};

/**
 * IMPORTANT native-field note (verified against real storage on 2026-06):
 *
 * `assembleOpencode` only walks role-tagged text for the format-agnostic bits
 * (model / heuristic subject / Haiku recap input) — it carries NO usage data. But
 * opencode's per-message JSON (`message/<sessionId>/<msgId>.json`) is rich:
 *   assistant message = {
 *     role: "assistant",
 *     time: { created, completed },          // ms; per-turn timestamp
 *     modelID, providerID,
 *     cost: 0.046089,                         // native per-message USD cost (a number)
 *     tokens: { input, output, reasoning,
 *               cache: { read, write } },     // native usage counts
 *     error?: { ... }                         // present iff the turn errored
 *   }
 * So we read these NATIVE fields here for tokens / native cost / per-turn sample
 * points / errored, and reuse `assembleOpencode` only for model+subject+recap.
 *
 * This is the full-adapter mirror of the openclaw adapter's native-usage pattern.
 */
export type OcMessageRow = {
  id?: string;
  role?: string;
  time?: { created?: number; completed?: number };
  modelID?: string;
  model?: { modelID?: string };
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  error?: unknown;
  /** Text parts hydrated from `part/<msgId>/*.json` (for the recap/subject). */
  texts?: string[];
  /** Distinct tool names off `type:"tool"` parts, when present. */
  tools?: string[];
};

/** One discovered opencode session: its row + native message rows. */
type OcRaw = { session: OcSessionRow; messages: OcMessageRow[] };

/** Map native message rows → the reporter's OcMessage shape for assembleOpencode. */
function toOcMessages(messages: OcMessageRow[]): OcMessage[] {
  return messages.map((m) => ({
    role: m.role ?? "user",
    created: m.time?.created ?? 0,
    modelID: m.model?.modelID ?? m.modelID,
    texts: m.texts ?? [],
  }));
}

/**
 * Pure: an opencode session row + its native message rows → persisted closed-session
 * row. FULL adapter: walks assistant messages for native tokens / per-message cost /
 * per-turn sample points / errored, reusing assembleOpencode only for the
 * content-derived bits (model, heuristic subject). Category is the provider DEFAULT
 * ("code") — opencode HAS a cwd (`directory`), so the orchestrator's resolveCategory
 * refines it via cwd rules (same as claude/codex); we do NOT hard-set a category.
 * resumeId stays undefined (opencode has no documented resume id → disabled button).
 * Never throws on garbage — a session with no usable usage yields a closed row with
 * no samples and an undefined cost.
 */
export function opencodeToImport(
  s: OcSessionRow,
  messages: OcMessageRow[],
): { session: PersistedSession; samples: SessionSample[]; events: PersistedEvent[] } {
  // Format-agnostic bits (model + heuristic summary slice) off the text parts.
  const base = assembleOpencode(toOcMessages(messages));

  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCacheRead = 0;
  let tokensCacheWrite = 0;
  let costTotal = 0;
  let sawCost = false;
  let errored = false;
  const toolSet = new Set<string>();
  let model: string | undefined = base.model;

  // Walk turns in chronological order so cumulative sample points ascend.
  const sorted = [...messages].sort(
    (a, b) => (a.time?.completed ?? a.time?.created ?? 0) - (b.time?.completed ?? b.time?.created ?? 0),
  );
  const points: Point[] = [];

  for (const m of sorted) {
    const mid = m.model?.modelID ?? m.modelID;
    if (typeof mid === "string" && mid) model = mid;
    if (m.error) errored = true;
    for (const t of m.tools ?? []) if (t) toolSet.add(t);

    const tk = m.tokens;
    if (!tk) continue;
    const fresh = tk.input ?? 0;
    const out = tk.output ?? 0;
    const cacheRead = tk.cache?.read ?? 0;
    const cacheWrite = tk.cache?.write ?? 0;
    tokensIn += fresh;
    tokensOut += out;
    tokensCacheRead += cacheRead;
    tokensCacheWrite += cacheWrite;

    const turnCost = m.cost;
    if (typeof turnCost === "number") {
      costTotal += turnCost;
      sawCost = true;
    }

    // Per-turn timestamp: completed when the turn finished, else created.
    const ts = m.time?.completed ?? m.time?.created;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue; // can't bucket — skip the point
    const occupancy = fresh + out + cacheRead + cacheWrite; // this turn's working set
    points.push({
      at: ts,
      cost_usd: typeof turnCost === "number" ? turnCost : null,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      tokens_cache_read: tokensCacheRead,
      tokens_cache_write: tokensCacheWrite,
      context_tokens: occupancy,
      context_window: null,
      cpu: null,
      mem_mb: null,
      active: 0,
    });
  }

  const tools = [...toolSet];
  const enr: BuildEnrichment = {
    model,
    // Heuristic subject: prefer the session title, else the recap slice.
    subjectInput: s.title ?? base.summary,
    tokensIn,
    tokensOut,
    tokensCacheRead,
    tokensCacheWrite,
    contextTokens: points.length ? points[points.length - 1].context_tokens : base.contextTokens,
    toolsUsed: tools.length ? tools : undefined,
  };

  const startedAt = s.time?.created ?? points[0]?.at ?? 0;
  const endedAt = s.time?.updated ?? points[points.length - 1]?.at ?? startedAt;

  return buildClosedSession({
    provider: "opencode",
    sessionKey: s.id,
    resumeId: undefined, // opencode has no documented resume id.
    cwd: s.directory ?? null,
    startedAt,
    endedAt,
    // Provider default; resolveCategory refines via cwd rules (opencode has a cwd).
    category: "code",
    enrichment: enr,
    points,
    errored,
    // Native per-message cost summed; undefined when no turn carried a cost.
    costUsd: sawCost ? costTotal : undefined,
  });
}

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Storage base: `~/.local/share/opencode/storage`. */
function storageBase(home: string): string {
  return join(home, ".local", "share", "opencode", "storage");
}

/** Recursively collect every `*.json` under `dir`. Guarded — [] when absent. */
function walkJson(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true })
      .map((e) => String(e))
      .filter((e) => e.endsWith(".json"));
  } catch {
    return [];
  }
}

/** Read + hydrate the native message rows (with text + tool parts) for a session. */
function loadMessages(base: string, sessionId: string): OcMessageRow[] {
  const msgDir = join(base, "message", sessionId);
  let files: string[];
  try {
    files = readdirSync(msgDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: OcMessageRow[] = [];
  for (const f of files) {
    const m = readJson(join(msgDir, f)) as OcMessageRow | null;
    if (!m?.id) continue;
    const partDir = join(base, "part", m.id);
    let parts: string[] = [];
    try {
      parts = readdirSync(partDir).filter((p) => p.endsWith(".json"));
    } catch {
      /* no parts */
    }
    const texts: string[] = [];
    const tools: string[] = [];
    for (const pf of parts) {
      const p = readJson(join(partDir, pf));
      if (p?.type === "text" && typeof p.text === "string") texts.push(p.text);
      // Best-effort tool extraction: opencode tool parts carry a tool name. Only
      // populated when present — never forced (the small fixtures had none).
      else if (p?.type === "tool") {
        const name = p.tool ?? p.name ?? p.toolName;
        if (typeof name === "string" && name) tools.push(name);
      }
    }
    m.texts = texts;
    if (tools.length) m.tools = tools;
    out.push(m);
  }
  return out;
}

export const opencodeBackfillAdapter: BackfillAdapter = {
  id: "opencode",
  available(opts?: { home?: string }): boolean {
    try {
      const home = opts?.home ?? os.homedir();
      return existsSync(join(storageBase(home), "session"));
    } catch {
      return false;
    }
  },
  *discover(opts: BackfillOpts): Iterable<RawSession> {
    const home = opts.home ?? os.homedir();
    const base = storageBase(home);
    const sessionDir = join(base, "session");
    for (const rel of walkJson(sessionDir)) {
      const session = readJson(join(sessionDir, rel)) as OcSessionRow | null;
      if (!session || typeof session.id !== "string") continue;
      const messages = loadMessages(base, session.id);
      const raw: OcRaw = { session, messages };
      yield raw;
    }
  },
  sessionKey(raw: RawSession): string {
    return (raw as OcRaw).session.id;
  },
  toImport(raw: RawSession) {
    const r = raw as OcRaw;
    return opencodeToImport(r.session, r.messages);
  },
  enrichInput(raw: RawSession): string {
    const r = raw as OcRaw;
    try {
      return trimTail(assembleOpencode(toOcMessages(r.messages)).summaryInput ?? "");
    } catch {
      return "";
    }
  },
};
