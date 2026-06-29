import Anthropic from "@anthropic-ai/sdk";

/** Result of analyzing a session: a broad subject + a recent recap + awaiting flag + the ask. */
export type Analysis = {
  subject?: string;
  summary?: string;
  awaitingUser?: boolean;
  ask?: string;
  suggestion?: string;
};

/** Analysis plus whether it reflects the CURRENT transcript (vs a stale cache). */
export type AnalyzeResult = Analysis & { fresh: boolean };

/** Inputs: the session's opening prompts (subject) + recent tail (recap). */
export type AnalyzeInput = { recent: string; subject?: string };

/** Analyze a session. Returns undefined on failure. */
export type GenerateFn = (input: AnalyzeInput) => Promise<Analysis | undefined>;

const SYSTEM =
  "You analyze an AI coding/agent session and return JSON with two levels:\n" +
  "- subject: the overall subject of the session as a short noun phrase (max ~10 words), " +
  "based mainly on the INITIAL REQUESTS. If clearly multiple distinct topics, name the main ones.\n" +
  "- summary: ONE concise sentence (max 15 words) on what the session is CURRENTLY doing. No preamble/quotes.\n" +
  "- awaiting_user: true ONLY if the assistant's MOST RECENT message ends by asking the user a " +
  "question or otherwise cannot proceed without the user's reply/decision/approval. " +
  "false if it is still working, running tools, or merely reporting progress.\n" +
  "- ask: when awaiting_user is true, a short phrase (max ~14 words) stating exactly what the user " +
  "must answer, decide, or approve. Empty string when awaiting_user is false.\n" +
  "- suggestion: when awaiting_user is true, a single plausible reply the user could send to move " +
  "forward, phrased exactly as the user would type it (max ~10 words, e.g. 'yes, proceed' or " +
  "'mark it ready for review'). Empty string when awaiting_user is false.";

const SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    summary: { type: "string" },
    awaiting_user: { type: "boolean" },
    ask: { type: "string" },
    suggestion: { type: "string" },
  },
  required: ["subject", "summary", "awaiting_user", "ask", "suggestion"],
  additionalProperties: false,
} as const;

/** Build a Haiku-backed generator, or null when no API key is configured. */
export function anthropicGenerator(model = "claude-haiku-4-5"): GenerateFn | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  return async ({ recent, subject }) => {
    const content =
      (subject ? `=== Session start (initial requests) ===\n${subject.slice(0, 2000)}\n\n` : "") +
      `=== Recent activity ===\n${recent.slice(-6000)}`;
    const msg = await client.messages.create({
      model,
      max_tokens: 220,
      system: SYSTEM,
      // Haiku 4.5: no effort/extended-thinking params. Structured output guarantees JSON.
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    });
    const block = msg.content.find((b) => b.type === "text");
    if (block?.type !== "text") return undefined;
    try {
      const parsed = JSON.parse(block.text);
      return {
        subject: typeof parsed.subject === "string" ? parsed.subject.trim() : undefined,
        summary: typeof parsed.summary === "string" ? parsed.summary.trim() : undefined,
        awaitingUser: parsed.awaiting_user === true,
        ask: typeof parsed.ask === "string" && parsed.ask.trim() ? parsed.ask.trim() : undefined,
        suggestion:
          typeof parsed.suggestion === "string" && parsed.suggestion.trim()
            ? parsed.suggestion.trim()
            : undefined,
      };
    } catch {
      return undefined;
    }
  };
}

/** Tiny stable hash so we only re-summarize when the input actually changed. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

type Entry = { hash: string; result: Analysis; lastRunAt: number; inFlight: boolean };

export type SummarizerOpts = { minIntervalMs?: number; now?: () => number };

/**
 * Caches per-session analysis (recap + awaiting-user). `analyze` is synchronous
 * and non-blocking: it returns the cached result immediately and schedules a
 * background refresh when the transcript changed and the throttle has elapsed.
 */
export class Summarizer {
  private cache = new Map<string, Entry>();
  private pending = new Map<string, Promise<void>>();
  private minIntervalMs: number;
  private now: () => number;

  constructor(
    private generate: GenerateFn | null,
    opts: SummarizerOpts = {},
  ) {
    this.minIntervalMs = opts.minIntervalMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  get active(): boolean {
    return this.generate !== null;
  }

  setMinInterval(ms: number): void {
    this.minIntervalMs = ms;
  }

  analyze(sessionId: string, recent: string, subject?: string): AnalyzeResult {
    if (!this.generate || !recent.trim()) return { fresh: true };
    const h = hash(`${recent}\x00${subject ?? ""}`); // re-run when recap OR subject input changes
    const e = this.cache.get(sessionId);
    if (e?.hash === h) return { ...e.result, fresh: true }; // matches current transcript

    const now = this.now();
    if (e && (e.inFlight || now - e.lastRunAt < this.minIntervalMs)) {
      // transcript changed but we're throttled: result is stale (don't trust action flags)
      return { ...e.result, fresh: false };
    }

    const entry: Entry = e ?? { hash: "", result: {}, lastRunAt: 0, inFlight: false };
    entry.inFlight = true;
    entry.lastRunAt = now;
    this.cache.set(sessionId, entry);

    const p = this.generate({ recent, subject })
      .then((result) => {
        if (result) {
          entry.result = result;
          entry.hash = h;
        }
      })
      .catch(() => {
        /* keep last good result */
      })
      .finally(() => {
        entry.inFlight = false;
        this.pending.delete(sessionId);
      });
    this.pending.set(sessionId, p);

    return { ...entry.result, fresh: false }; // stale until the refresh lands
  }

  /** Test helper: await any in-flight refreshes. */
  async settle(): Promise<void> {
    await Promise.all(this.pending.values());
  }
}
