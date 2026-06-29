/** Max context window (tokens) by model id. Used as the denominator for the
 * live context-window occupancy gauge. Approximate, list defaults. */
export const CONTEXT_WINDOW_TABLE: Record<string, number> = {
  // Opus 4.6+ and Fable 5 ship a 1M window at standard pricing — that's the
  // default. Sonnet's 1M is the opt-in `context-1m` beta; it DEFAULTS to 200K,
  // so 200K is the right denominator unless we knew the beta was on (we can't —
  // the transcript doesn't record it). Haiku is 200K.
  "claude-fable": 1_000_000,
  "claude-opus": 1_000_000,
  "claude-sonnet": 200_000,
  "claude-haiku": 200_000,
  "gpt-5": 272_000,
  "gpt-4": 128_000,
  "o3": 200_000,
};

/**
 * The model's max context window, by longest-prefix match (so "claude-opus-4-8"
 * hits "claude-opus"). A `[1m]` long-context tag forces 1M regardless of family
 * — though note Claude transcripts log the bare id ("claude-opus-4-8"), not the
 * `[1m]`-suffixed runtime string, so the table is what actually fires for claude.
 * Returns undefined when the model is unknown — callers render "—" / hide the
 * gauge rather than guess a denominator.
 */
export function contextWindowFor(model?: string): number | undefined {
  if (!model) return undefined;
  if (/\[1m\]/i.test(model)) return 1_000_000;
  let best: { key: string; win: number } | undefined;
  for (const [key, win] of Object.entries(CONTEXT_WINDOW_TABLE)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, win };
    }
  }
  return best?.win;
}
