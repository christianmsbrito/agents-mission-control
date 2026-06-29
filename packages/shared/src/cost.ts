/** USD per 1M tokens, by model id (prefix match). Approximate list prices. */
export type Price = { in: number; out: number };

// USD per 1M tokens (current list prices). Cache reads billed at CACHE_READ_FACTOR.
export const PRICE_TABLE: Record<string, Price> = {
  "claude-fable": { in: 10, out: 50 },
  "claude-opus": { in: 5, out: 25 },
  "claude-sonnet": { in: 3, out: 15 },
  "claude-haiku": { in: 1, out: 5 },
  "gpt-5": { in: 1.25, out: 10 },
  "gpt-4": { in: 2.5, out: 10 },
  "o3": { in: 2, out: 8 },
};

/** Longest-prefix match so "claude-opus-4-8" hits "claude-opus". */
export function priceFor(model?: string): Price | undefined {
  if (!model) return undefined;
  let best: { key: string; price: Price } | undefined;
  for (const [key, price] of Object.entries(PRICE_TABLE)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best?.price;
}

/** Cache reads are billed at ~10% of fresh-input price. */
export const CACHE_READ_FACTOR = 0.1;
/** Cache writes (5-min TTL) are billed at ~1.25x of fresh-input price. */
export const CACHE_WRITE_FACTOR = 1.25;

/** Estimated cost in USD. Returns undefined when model unknown or no tokens. */
export function estimateCost(
  model?: string,
  tokensIn = 0,
  tokensOut = 0,
  tokensCacheRead = 0,
  tokensCacheWrite = 0,
): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  if (!tokensIn && !tokensOut && !tokensCacheRead && !tokensCacheWrite) return 0;
  const usd =
    (tokensIn * price.in +
      tokensCacheRead * price.in * CACHE_READ_FACTOR +
      tokensCacheWrite * price.in * CACHE_WRITE_FACTOR +
      tokensOut * price.out) /
    1_000_000;
  return Math.round(usd * 10000) / 10000;
}
