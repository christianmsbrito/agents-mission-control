/** User-overridable mapping from a session to its role/category. */
export type CategoryConfig = {
  /** provider id -> category, e.g. { claude: "code", codex: "review" }. */
  byProvider?: Record<string, string>;
  /** cwd regex rules, checked in order; first match wins. Beats byProvider. */
  byCwd?: { match: RegExp; category: string }[];
};

export const FALLBACK_CATEGORY = "uncategorized";

/** Wire/persisted form of CategoryConfig: byCwd match is a string pattern, not RegExp. */
export type SerializableCategoryConfig = {
  byProvider?: Record<string, string>;
  byCwd?: { match: string; category: string }[];
};

/** Compile string patterns to RegExp rules, silently dropping invalid ones. */
export function compileCwdRules(config: SerializableCategoryConfig): CategoryConfig {
  const byCwd: { match: RegExp; category: string }[] = [];
  for (const rule of config.byCwd ?? []) {
    try {
      byCwd.push({ match: new RegExp(rule.match), category: rule.category });
    } catch {
      /* skip invalid pattern — never throw into ingest */
    }
  }
  return { byProvider: config.byProvider, byCwd };
}

/**
 * Resolve a session's category. Precedence: byCwd (first match) > byProvider >
 * provider's defaultCategory > FALLBACK_CATEGORY.
 */
export function resolveCategory(
  provider: string,
  cwd: string | null,
  providerDefault: string | undefined,
  config: CategoryConfig = {},
): string {
  if (cwd && config.byCwd) {
    for (const rule of config.byCwd) {
      if (rule.match.test(cwd)) return rule.category;
    }
  }
  return config.byProvider?.[provider] ?? providerDefault ?? FALLBACK_CATEGORY;
}
