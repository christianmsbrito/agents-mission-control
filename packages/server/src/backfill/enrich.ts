import Anthropic from "@anthropic-ai/sdk";
import type { Store } from "../store.ts";

/** One session to analyze: its registry key, optional heuristic subject, and tail. */
export type EnrichItem = { id: string; subject?: string; tail: string };

/** Model-derived recap for one session, keyed back by the input `id`. */
export type EnrichResult = {
  id: string;
  subject?: string;
  summary?: string;
  awaitingUser?: boolean;
  ask?: string;
  suggestion?: string;
};

/** Injectable batch analyzer: takes N sessions, returns N (or fewer) results.
 * Tests pass a fake; prod wraps one Haiku call per batch. */
export type BatchAnalyze = (items: EnrichItem[]) => Promise<EnrichResult[]>;

const MAX_TAIL = 6000;

const SYSTEM =
  "You analyze a NUMBERED LIST of past AI coding/agent sessions. For EACH session, " +
  "return one object keyed by the given `id`. Per session return:\n" +
  "- id: echo the session's given id EXACTLY.\n" +
  "- subject: the overall subject as a short noun phrase (max ~10 words), based mainly on the " +
  "initial requests in the tail. If clearly multiple distinct topics, name the main ones.\n" +
  "- summary: ONE concise sentence (max 15 words) on what the session was doing. No preamble/quotes.\n" +
  "- awaiting_user: true ONLY if the session's FINAL assistant turn left the user something to " +
  "answer, decide, or approve (resume-relevant for this closed session). false if it was still " +
  "working, running tools, or merely reporting progress.\n" +
  "- ask: when awaiting_user is true, a short phrase (max ~14 words) stating exactly what the user " +
  "must answer/decide/approve. Empty string otherwise.\n" +
  "- suggestion: when awaiting_user is true, a single plausible reply phrased exactly as the user " +
  "would type it (max ~10 words). Empty string otherwise.\n" +
  "Return one object PER input id. Do not invent ids.";

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    subject: { type: "string" },
    summary: { type: "string" },
    awaiting_user: { type: "boolean" },
    ask: { type: "string" },
    suggestion: { type: "string" },
  },
  required: ["id", "subject", "summary", "awaiting_user", "ask", "suggestion"],
  additionalProperties: false,
} as const;

// The SDK's json_schema slot is a loose `{ [k]: unknown }`; rather than rely on a
// top-level array being accepted, wrap the array in an object under `results`
// (the most portable structured-output shape) and read `.results` back.
const SCHEMA = {
  type: "object",
  properties: { results: { type: "array", items: ITEM_SCHEMA } },
  required: ["results"],
  additionalProperties: false,
} as const;

/** Pure text→results parser for the model's structured output. Tolerant of both
 * the top-level array form and the `{results:[...]}` wrapper, of dropped/extra
 * ids, and of malformed JSON (returns []). Items without a string `id` are
 * skipped; empty/whitespace strings coerce to undefined; `awaiting_user`→`awaitingUser`.
 * Exported for unit testing — this is where structured-output drift bites first. */
export function parseAnalyzeResponse(text: string): EnrichResult[] {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const arr: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];
  const out: EnrichResult[] = [];
  for (const r of arr) {
    if (typeof r?.id !== "string") continue;
    out.push({
      id: r.id,
      subject: typeof r.subject === "string" && r.subject.trim() ? r.subject.trim() : undefined,
      summary: typeof r.summary === "string" && r.summary.trim() ? r.summary.trim() : undefined,
      awaitingUser: r.awaiting_user === true,
      ask: typeof r.ask === "string" && r.ask.trim() ? r.ask.trim() : undefined,
      suggestion:
        typeof r.suggestion === "string" && r.suggestion.trim() ? r.suggestion.trim() : undefined,
    });
  }
  return out;
}

/** Build a Haiku-backed batch analyzer, or null when no API key is configured.
 * One messages.create per batch; never called in tests (always inject a fake). */
export function anthropicBatchAnalyze(model = "claude-haiku-4-5"): BatchAnalyze | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  return async (items) => {
    const list = items
      .map(
        (it) =>
          `--- session id=${it.id}${it.subject ? ` subject=${JSON.stringify(it.subject)}` : ""} ---\n` +
          it.tail.slice(-MAX_TAIL),
      )
      .join("\n\n");
    const content = `Analyze these ${items.length} sessions and return one result per id.\n\n${list}`;
    const msg = await client.messages.create({
      model,
      // ~220 tok/session: subject+summary+ask+suggestion with headroom.
      max_tokens: 220 * Math.max(1, items.length),
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    });
    const block = msg.content.find((b) => b.type === "text");
    if (block?.type !== "text") return [];
    return parseAnalyzeResponse(block.text);
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Enrich every registry row still missing a recap, in batched Haiku calls.
 * Graceful-degradation through-line:
 *   - `analyze` null (no key) → skippedPhase, nothing written.
 *   - a row with no captured tail → degraded (never sent to the model).
 *   - a batch that throws → retried once; on the second failure the whole chunk
 *     is degraded and the loop continues (never throws to the caller).
 *   - a result missing for some id → that row stays null and is degraded.
 * Mapping is id-keyed (not positional), so reordered/short responses are safe.
 */
export async function enrichMissing(
  store: Store,
  opts: {
    tails: Map<string, string>;
    analyze: BatchAnalyze | null;
    batchSize?: number;
    subjects?: Map<string, string>;
  },
): Promise<{ enriched: number; degraded: number; skippedPhase: boolean }> {
  if (!opts.analyze) return { enriched: 0, degraded: 0, skippedPhase: true };
  const analyze = opts.analyze;
  const batchSize = opts.batchSize ?? 15;

  let enriched = 0;
  let degraded = 0;

  const missing = store.sessionsMissingEnrichment();
  const items: EnrichItem[] = [];
  for (const m of missing) {
    const tail = opts.tails.get(m.sessionKey);
    if (!tail) {
      degraded++; // no captured tail → can't enrich
      continue;
    }
    items.push({ id: m.sessionKey, subject: opts.subjects?.get(m.sessionKey) ?? m.subject, tail });
  }

  for (const group of chunk(items, batchSize)) {
    let results: EnrichResult[] | null = null;
    try {
      results = await analyze(group);
    } catch {
      try {
        results = await analyze(group); // single retry
      } catch {
        results = null; // give up on this chunk
      }
    }
    if (results == null) {
      degraded += group.length; // whole chunk degraded
      continue;
    }
    const byId = new Map<string, EnrichResult>();
    for (const r of results) byId.set(r.id, r);
    for (const it of group) {
      const r = byId.get(it.id);
      if (!r) {
        degraded++; // model dropped this id
        continue;
      }
      store.applyEnrichment(it.id, {
        subject: r.subject,
        summary: r.summary,
        attention: r.awaitingUser,
        ask: r.ask,
        suggestion: r.suggestion,
      });
      enriched++;
    }
  }

  return { enriched, degraded, skippedPhase: false };
}
