/** RPG visual theme ("skin"). The first is Final Fantasy-style; more drop in by
 * adding a token block in styles.css under [data-skin="…"] and an entry here. */
export type Skin = "ff" | "terminal";
export const SKINS: { id: Skin; label: string }[] = [
  { id: "ff", label: "Final Fantasy" },
  { id: "terminal", label: "Terminal" },
];

export type Prefs = {
  skin: Skin;
  theme: "auto" | "light" | "dark";
  showCost: boolean;
  showTokens: boolean;
  sort: "activity" | "cost" | "started";
  density: "comfortable" | "compact";
  hiddenCategories: string[];
  hiddenProviders: string[];
  hiddenHosts: string[];
  /** Hide idle/phantom sessions — those under `minTokens` total tokens (ran but never
   * really worked). On by default. Active/running sessions are never hidden by this. */
  hideIdle: boolean;
  /** Token floor for `hideIdle`: a session below this total is treated as idle/phantom. */
  minTokens: number;
};

export const DEFAULT_PREFS: Prefs = {
  skin: "ff",
  theme: "auto", showCost: true, showTokens: true, sort: "activity",
  density: "comfortable",
  hiddenCategories: [], hiddenProviders: [], hiddenHosts: [],
  hideIdle: true, minTokens: 1000,
};

/** Total tokens a session consumed (fresh + cache read/write + output). */
export function totalTokens(s: {
  tokensIn?: number; tokensOut?: number; tokensCacheRead?: number; tokensCacheWrite?: number;
}): number {
  return (s.tokensIn ?? 0) + (s.tokensOut ?? 0) + (s.tokensCacheRead ?? 0) + (s.tokensCacheWrite ?? 0);
}

/** An idle/phantom session: total tokens below the floor (ran but did ~nothing). */
export function isIdle(
  s: { tokensIn?: number; tokensOut?: number; tokensCacheRead?: number; tokensCacheWrite?: number },
  minTokens: number,
): boolean {
  return totalTokens(s) < minTokens;
}

export type PrefsAction =
  | { type: "setSkin"; value: Skin }
  | { type: "setTheme"; value: Prefs["theme"] }
  | { type: "setSort"; value: Prefs["sort"] }
  | { type: "setDensity"; value: Prefs["density"] }
  | { type: "setMinTokens"; value: number }
  | { type: "toggle"; key: "showCost" | "showTokens" | "hideIdle" }
  | { type: "toggleHiddenCategory"; value: string }
  | { type: "toggleHiddenProvider"; value: string }
  | { type: "toggleHiddenHost"; value: string };

function toggleIn(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export function prefsReducer(s: Prefs, a: PrefsAction): Prefs {
  switch (a.type) {
    case "setSkin": return { ...s, skin: a.value };
    case "setTheme": return { ...s, theme: a.value };
    case "setSort": return { ...s, sort: a.value };
    case "setDensity": return { ...s, density: a.value };
    case "setMinTokens": return { ...s, minTokens: Math.max(0, a.value) };
    case "toggle": return { ...s, [a.key]: !s[a.key] };
    case "toggleHiddenCategory": return { ...s, hiddenCategories: toggleIn(s.hiddenCategories, a.value) };
    case "toggleHiddenProvider": return { ...s, hiddenProviders: toggleIn(s.hiddenProviders, a.value) };
    case "toggleHiddenHost": return { ...s, hiddenHosts: toggleIn(s.hiddenHosts, a.value) };
  }
}

const KEY = "mc.prefs";
export function loadPrefs(): Prefs {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
  catch { return DEFAULT_PREFS; }
}
export function savePrefs(p: Prefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
