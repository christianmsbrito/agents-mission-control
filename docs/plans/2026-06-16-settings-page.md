# Settings Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a live settings surface to the Mission Control dashboard — browser-view prefs (localStorage), server-runtime config (stale timeout + category mapping, persisted on the server host), and summary settings pushed down to reporters over the existing command channel.

**Architecture:** All wire changes are additive. A shared `AppConfig` is held in memory on the server, persisted to `~/.mission-control/config.json`, broadcast to browsers via a new `settings` `LiveMsg`, and patched via a new `set-settings` `WebToServerMsg`. Category ownership moves to the server: `hub.ingest()` re-resolves `category` from `provider`+`cwd`. Summary settings cross to reporters via a new `config` `ServerToReporterMsg`, re-pushed on `hello`. Browser prefs never touch the backend.

**Tech Stack:** Bun, TypeScript (`.ts` imports with explicit extensions), React 19, `Bun.serve` WebSockets, `bun test`.

**Design doc:** `docs/plans/2026-06-16-settings-page-design.md` (on `main`).

**Conventions reminder:** pure-function-first tests (no I/O in unit tests); side-effects (fs, sockets, `ps`) stay at the edges; `enrich`/ingest must never throw. Commit after every passing task.

---

## Task 1: Shared `AppConfig` type + serializable categories

**Files:**
- Modify: `packages/shared/src/category.ts`
- Modify: `packages/shared/src/types.ts`
- Test: `packages/shared/src/category.test.ts` (create if absent)

**Step 1: Write the failing test**

Add to `packages/shared/src/category.test.ts`:

```ts
import { test, expect } from "bun:test";
import { compileCwdRules, resolveCategory, type SerializableCategoryConfig } from "./category.ts";

test("compileCwdRules turns string patterns into RegExp rules", () => {
  const cfg: SerializableCategoryConfig = { byCwd: [{ match: "/work/", category: "code" }] };
  const compiled = compileCwdRules(cfg);
  expect(resolveCategory("claude", "/work/app", undefined, compiled)).toBe("code");
});

test("compileCwdRules drops invalid regex without throwing", () => {
  const cfg: SerializableCategoryConfig = { byCwd: [{ match: "(", category: "x" }] };
  const compiled = compileCwdRules(cfg);
  expect(compiled.byCwd).toEqual([]); // bad pattern skipped
  expect(resolveCategory("claude", "/work", "research", compiled)).toBe("research");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/category.test.ts`
Expected: FAIL — `compileCwdRules` / `SerializableCategoryConfig` not exported.

**Step 3: Implement**

In `packages/shared/src/category.ts`, add above `resolveCategory`:

```ts
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
```

In `packages/shared/src/types.ts`, append:

```ts
import type { SerializableCategoryConfig } from "./category.ts";

/** Server-held, persisted runtime configuration of the whole board. */
export type AppConfig = {
  /** Drop a host as offline after this many ms of silence. */
  staleMs: number;
  /** Role mapping, re-resolved server-side on every ingest. */
  categories: SerializableCategoryConfig;
  /** Reporter-side LLM recap settings, pushed to reporters. */
  summaries: { enabled: boolean; model: string; minIntervalMs: number };
};
```

(If `types.ts` already imports from `category.ts`, merge the import rather than duplicating.)

**Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/category.test.ts`
Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add packages/shared/src/category.ts packages/shared/src/category.test.ts packages/shared/src/types.ts
git commit -m "feat(shared): AppConfig type + serializable category compile"
```

---

## Task 2: New wire messages (settings / set-settings / config)

**Files:**
- Modify: `packages/shared/src/types.ts`

**Step 1: Add the message types**

In `packages/shared/src/types.ts`:

- Extend `ServerToReporterMsg`:
```ts
export type ConfigMsg = { type: "config"; summaries: AppConfig["summaries"] };
export type ServerToReporterMsg = FocusMsg | KillMsg | PromptMsg | ConfigMsg;
```

- Extend `WebToServerMsg`:
```ts
export type SetSettingsRequest = { type: "set-settings"; patch: Partial<AppConfig> };
export type WebToServerMsg = FocusRequest | KillRequest | PromptRequest | SetSettingsRequest;
```

- Extend `LiveMsg`:
```ts
export type SettingsMsg = { type: "settings"; config: AppConfig };
export type LiveMsg = StateMsg | PatchMsg | OfflineMsg | SettingsMsg;
```

**Step 2: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: no new errors. (Existing switch handlers still compile — the new variants are not yet handled but TS unions don't force exhaustiveness here.)

**Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): settings/set-settings/config wire messages"
```

---

## Task 3: `loadAppConfig` + `applySettings` (pure config core)

**Files:**
- Create: `packages/server/src/config.ts`
- Test: `packages/server/src/config.test.ts`

**Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { defaultConfig, mergeConfig, applySettings } from "./config.ts";

test("defaultConfig pulls staleMs from env default", () => {
  expect(defaultConfig({}).staleMs).toBe(10_000);
  expect(defaultConfig({ MC_STALE_MS: "5000" }).staleMs).toBe(5000);
});

test("mergeConfig overlays a persisted file over defaults", () => {
  const merged = mergeConfig(defaultConfig({}), { staleMs: 4000 });
  expect(merged.staleMs).toBe(4000);
  expect(merged.summaries.enabled).toBe(true); // default preserved
});

test("applySettings deep-merges a patch and clamps staleMs to a 2000ms floor", () => {
  const base = defaultConfig({});
  const next = applySettings(base, { staleMs: 100 });
  expect(next.staleMs).toBe(2000); // clamped
  const cats = applySettings(base, { categories: { byProvider: { codex: "review" } } });
  expect(cats.categories.byProvider).toEqual({ codex: "review" });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/src/config.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement** `packages/server/src/config.ts`:

```ts
import type { AppConfig } from "@mc/shared";

const STALE_FLOOR_MS = 2000;

/** Defaults sourced from env (falls back to hardcoded). Pure: env passed in. */
export function defaultConfig(env: Record<string, string | undefined>): AppConfig {
  return {
    staleMs: Number(env.MC_STALE_MS || 10_000),
    categories: {},
    summaries: {
      enabled: env.MC_SUMMARIES !== "0",
      model: env.MC_SUMMARY_MODEL || "claude-haiku-4-5",
      minIntervalMs: Number(env.MC_SUMMARY_INTERVAL_MS || 60_000),
    },
  };
}

/** Overlay a (partial) persisted config over a base. */
export function mergeConfig(base: AppConfig, over: Partial<AppConfig>): AppConfig {
  return {
    staleMs: over.staleMs ?? base.staleMs,
    categories: over.categories ?? base.categories,
    summaries: { ...base.summaries, ...over.summaries },
  };
}

/** Apply a UI patch with validation/clamping. Pure. */
export function applySettings(base: AppConfig, patch: Partial<AppConfig>): AppConfig {
  const merged = mergeConfig(base, patch);
  return { ...merged, staleMs: Math.max(STALE_FLOOR_MS, merged.staleMs) };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/server/src/config.test.ts`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add packages/server/src/config.ts packages/server/src/config.test.ts
git commit -m "feat(server): pure config core (default/merge/applySettings)"
```

---

## Task 4: Hub re-resolves category on ingest + mutable staleMs

**Files:**
- Modify: `packages/server/src/hub.ts`
- Test: `packages/server/src/hub.test.ts`

**Step 1: Write the failing test**

Add to `packages/server/src/hub.test.ts`:

```ts
test("ingest re-resolves category from the live mapping", () => {
  let cats = { byProvider: { codex: "review" } };
  const hub = new Hub(10_000, () => cats);
  const report = {
    hostId: "h1", hostLabel: "h1", sentAt: 0,
    sessions: [{ id: "h1:1", provider: "codex", pid: 1, hostId: "h1", hostLabel: "h1",
      cwd: null, category: "uncategorized", startedAt: 0, cpu: 0, memMb: 0 }],
  };
  hub.ingest(report as any, 0);
  expect(hub.snapshot()[0].sessions[0].category).toBe("review");
  cats = { byProvider: { codex: "research" } };
  hub.ingest(report as any, 0);
  expect(hub.snapshot()[0].sessions[0].category).toBe("research");
});

test("setStaleMs changes sweep behavior", () => {
  const hub = new Hub(10_000, () => ({}));
  hub.ingest({ hostId: "h1", hostLabel: "h1", sentAt: 0, sessions: [] } as any, 0);
  hub.setStaleMs(3000);
  hub.sweep(4000); // 4000 > 3000 -> dropped
  expect(hub.snapshot()).toEqual([]);
});
```

Update the existing `Hub` constructions in the test file to pass `() => ({})` as the 2nd arg.

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/src/hub.test.ts`
Expected: FAIL — constructor arity / `setStaleMs` missing.

**Step 3: Implement** in `packages/server/src/hub.ts`:

- Update import: `import type { HostReport, LiveMsg, SerializableCategoryConfig } from "@mc/shared";`
  and `import { compileCwdRules, resolveCategory } from "@mc/shared";`
- Replace the constructor:
```ts
  constructor(
    private staleMs = 10_000,
    private getCategories: () => SerializableCategoryConfig = () => ({}),
  ) {}

  setStaleMs(ms: number): void {
    this.staleMs = ms;
  }
```
- In `ingest()`, before `this.hosts.set(...)`, re-resolve each session's category:
```ts
  ingest(report: HostReport, now: number): void {
    const cats = compileCwdRules(this.getCategories());
    for (const s of report.sessions) {
      s.category = resolveCategory(s.provider, s.cwd, undefined, cats);
    }
    this.hosts.set(report.hostId, report);
    this.lastSeen.set(report.hostId, now);
    this.broadcast({ type: "patch", report });
  }
```

Note: `resolveCategory`'s 3rd arg (providerDefault) is undefined here because the reporter has already applied the provider default into `s.category`; to preserve provider defaults, pass `s.category` instead of `undefined` ONLY when no mapping matches. Simpler and correct: keep `undefined` and rely on `byProvider`/fallback — but to retain reporter provider-defaults, use `resolveCategory(s.provider, s.cwd, s.category, cats)` so an unmapped session keeps the reporter's resolved default. **Use `s.category` as providerDefault.** Update the test's first assertion expectation accordingly (mapped provider still wins over the default).

**Step 4: Run test to verify it passes**

Run: `bun test packages/server/src/hub.test.ts`
Expected: PASS (existing + 2 new).

**Step 5: Commit**

```bash
git add packages/server/src/hub.ts packages/server/src/hub.test.ts
git commit -m "feat(server): hub re-resolves category on ingest + mutable staleMs"
```

---

## Task 5: Wire config into the server transport (boot, persist, handlers)

**Files:**
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/src/server.test.ts` (extend if it exercises the live socket)

**Step 1: Boot — load + persist helpers**

At the top of `index.ts` (after imports), replace the `STALE_MS`/`new Hub` block:

```ts
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { defaultConfig, mergeConfig, applySettings } from "./config.ts";
import type { AppConfig } from "@mc/shared";

const CONFIG_FILE = join(homedir(), ".mission-control", "config.json");

function loadAppConfig(): AppConfig {
  const base = defaultConfig(process.env);
  try {
    return mergeConfig(base, JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
  } catch {
    return base; // missing/corrupt -> defaults
  }
}

let config = loadAppConfig();
const hub = new Hub(config.staleMs, () => config.categories);

async function persistConfig(): Promise<void> {
  try {
    await mkdir(join(homedir(), ".mission-control"), { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch {
    /* best-effort, like publishEvent */
  }
}
```

(`mkdir` is already imported. Remove the now-dead `STALE_MS` const.)

**Step 2: Send settings on `/ws/live` connect**

In the `open(ws)` handler, where `kind === "live"` subscribes, send the current config right after subscribing:

```ts
        ws.data.unsub = hub.subscribe(send);
        send({ type: "settings", config });
```

**Step 3: Handle `set-settings` in the live `message` branch**

Inside the `if (m.type === "focus" || ...)` area, add a sibling branch:

```ts
        if (m.type === "set-settings") {
          config = applySettings(config, m.patch);
          void persistConfig();
          hub.setStaleMs(config.staleMs);
          if (m.patch.categories) reresolveAndRebroadcast();
          if (m.patch.summaries) pushConfigToReporters();
          broadcastSettings();
          return;
        }
```

Add helpers near the other module functions:

```ts
function broadcastSettings(): void {
  hub.broadcastSettings(config); // see Step 4
}
function pushConfigToReporters(): void {
  for (const r of reporters.values())
    r.send(JSON.stringify({ type: "config", summaries: config.summaries }));
}
function reresolveAndRebroadcast(): void {
  for (const report of hub.snapshot()) hub.ingest(report, Date.now());
}
```

**Step 4: Add `broadcastSettings` to the hub**

In `hub.ts`, expose a method (keeps `broadcast` private):

```ts
  broadcastSettings(config: AppConfig): void {
    this.broadcast({ type: "settings", config });
  }
```

(Import `AppConfig` in `hub.ts`.)

**Step 5: Re-push config on reporter `hello`**

In the reporter-auth branch (`msg.type === "hello"`), after `reporters.set(msg.hostId, ws);`:

```ts
        ws.send(JSON.stringify({ type: "config", summaries: config.summaries }));
```

**Step 6: Run the full server suite**

Run: `bun test packages/server`
Expected: PASS. If `server.test.ts` opens a `/ws/live` socket, add an assertion that the first or second message received is `{type:"settings"}`.

**Step 7: Commit**

```bash
git add packages/server/src/index.ts packages/server/src/hub.ts
git commit -m "feat(server): load/persist AppConfig, settings broadcast + set-settings handler"
```

---

## Task 6: Reporter applies pushed `config`

**Files:**
- Modify: `packages/reporter/src/index.ts`

**Step 1: Handle the `config` message**

In `ws.onmessage`, add a branch (after the `prompt` branch):

```ts
    } else if (msg.type === "config") {
      cfg.summaries = msg.summaries;
      summarizer.setMinInterval(msg.summaries.minIntervalMs);
      console.log(`[reporter] config: summaries=${msg.summaries.enabled ? "on" : "off"} model=${msg.summaries.model}`);
    }
```

**Step 2: Make the summarizer honor live changes**

Check `packages/reporter/src/summarizer.ts`. The summarizer is constructed once with `{minIntervalMs}` and a generator bound to a model at boot. Two changes:
- Add `setMinInterval(ms)` to the `Summarizer` class (mutate its private interval). Add a focused unit test in `summarizer.test.ts` if the field is observable; otherwise keep it minimal.
- Model/enabled changes mid-run: the generator is created once at boot from `cfg.summaries`. Honoring a model swap live requires rebuilding the generator. For this iteration, document that `enabled`/`model` changes take effect on reporter restart (the pushed value persists in `cfg` and re-pushes on `hello`), while `minIntervalMs` applies live. **Confirm this scope is acceptable in review** — full live model swap is a follow-up if needed.

**Step 3: Verify reporter still builds/tests**

Run: `bun test packages/reporter`
Expected: PASS.

**Step 4: Commit**

```bash
git add packages/reporter/src/index.ts packages/reporter/src/summarizer.ts
git commit -m "feat(reporter): apply pushed summary config (min-interval live)"
```

---

## Task 7: Browser prefs hook (`usePrefs`) — pure reducer + localStorage

**Files:**
- Create: `packages/web/src/prefs.ts`
- Test: `packages/web/src/prefs.test.ts`

**Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { DEFAULT_PREFS, prefsReducer, type Prefs } from "./prefs.ts";

test("toggle a category filter into the hidden set", () => {
  const next = prefsReducer(DEFAULT_PREFS, { type: "toggleHiddenCategory", value: "review" });
  expect(next.hiddenCategories).toContain("review");
  const back = prefsReducer(next, { type: "toggleHiddenCategory", value: "review" });
  expect(back.hiddenCategories).not.toContain("review");
});

test("set sort and density", () => {
  const next = prefsReducer(DEFAULT_PREFS, { type: "setSort", value: "cost" });
  expect(next.sort).toBe("cost");
  expect(prefsReducer(DEFAULT_PREFS, { type: "setDensity", value: "compact" }).density).toBe("compact");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/web/src/prefs.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement** `packages/web/src/prefs.ts`:

```ts
export type Prefs = {
  theme: "auto" | "light" | "dark";
  showCost: boolean;
  showTokens: boolean;
  sort: "activity" | "cost" | "started";
  density: "comfortable" | "compact";
  showOffline: boolean;
  hiddenCategories: string[];
  hiddenProviders: string[];
  hiddenHosts: string[];
};

export const DEFAULT_PREFS: Prefs = {
  theme: "auto", showCost: true, showTokens: true, sort: "activity",
  density: "comfortable", showOffline: true,
  hiddenCategories: [], hiddenProviders: [], hiddenHosts: [],
};

export type PrefsAction =
  | { type: "setTheme"; value: Prefs["theme"] }
  | { type: "setSort"; value: Prefs["sort"] }
  | { type: "setDensity"; value: Prefs["density"] }
  | { type: "toggle"; key: "showCost" | "showTokens" | "showOffline" }
  | { type: "toggleHiddenCategory"; value: string }
  | { type: "toggleHiddenProvider"; value: string }
  | { type: "toggleHiddenHost"; value: string };

function toggleIn(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export function prefsReducer(s: Prefs, a: PrefsAction): Prefs {
  switch (a.type) {
    case "setTheme": return { ...s, theme: a.value };
    case "setSort": return { ...s, sort: a.value };
    case "setDensity": return { ...s, density: a.value };
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
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/web/src/prefs.test.ts`
Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add packages/web/src/prefs.ts packages/web/src/prefs.test.ts
git commit -m "feat(web): usePrefs reducer + localStorage persistence"
```

---

## Task 8: useLive grows `config` + `setSettings`

**Files:**
- Modify: `packages/web/src/useLive.ts`

**Step 1: Implement**

- Add `import type { HostReport, LiveMsg, AppConfig } from "@mc/shared";`
- Add state: `const [config, setConfig] = useState<AppConfig | null>(null);`
- In `onmessage`, handle settings before the `setHosts` block:
```ts
        const msg: LiveMsg = JSON.parse(e.data);
        if (msg.type === "settings") { setConfig(msg.config); return; }
```
- Add sender + return it:
```ts
  const setSettings = (patch: Partial<AppConfig>) => sendMsg({ type: "set-settings", patch });
  return { hosts, conn, config, focus, kill, prompt, setSettings };
```

**Step 2: Verify build**

Run: `bun run build:web`
Expected: builds with no type errors.

**Step 3: Commit**

```bash
git add packages/web/src/useLive.ts
git commit -m "feat(web): useLive exposes config + setSettings"
```

---

## Task 9: Settings slide-over panel + apply prefs in App

**Files:**
- Modify: `packages/web/src/App.tsx`
- Create: `packages/web/src/Settings.tsx`
- Modify: `packages/web/src/styles.css`

**Step 1: Build the `Settings` panel component**

Create `packages/web/src/Settings.tsx` — a slide-over with two sections:
- **Display** (props: `prefs`, `dispatch`): theme `<select>`, `showCost`/`showTokens`/`showOffline` checkboxes, sort `<select>`, density toggle, and filter checkbox lists for the `categories`/`providers`/`hosts` derived from live data (passed in as string arrays).
- **Server & fleet** (props: `config: AppConfig`, `onSave: (patch) => void`): stale-timeout number input (ms), category mapping editor (byProvider rows provider→category; byCwd rows pattern→category, add/remove row), summaries `enabled`/`model`/`minIntervalMs`. Each control calls `onSave` with a minimal patch on change/blur. Render from `config` (the server echo), not local state, so it reflects accepted values.

Keep it dependency-free (plain controlled inputs). Gate the whole "Server & fleet" section behind `config != null`.

**Step 2: Wire into `App.tsx`**

- `const { hosts, conn, config, focus, kill, prompt, setSettings } = useLive(WS_URL);`
- `const [prefs, dispatch] = useReducer(prefsReducer, undefined, loadPrefs);`
- `useEffect(() => savePrefs(prefs), [prefs]);`
- Apply theme: `useEffect(() => { document.documentElement.dataset.theme = prefs.theme; }, [prefs.theme]);`
- Add a gear button in the header that toggles a `const [showSettings, setShowSettings] = useState(false);`
- Derive filter option lists from `hosts` (unique categories/providers/hostLabels).
- Before grouping/rendering, filter sessions: drop those whose `category`/`provider`/`hostId` is in the respective hidden list; drop offline hosts if `!prefs.showOffline`. Sort per `prefs.sort`. Pass `prefs.showCost`/`prefs.showTokens` down to `SessionCard` to gate those fields. Apply `prefs.density` as a class on the grid container.

**Step 3: Styles**

Add `.settings-panel` slide-over styles to `styles.css` (fixed right, translateX transition, overlay). Add `[data-theme="light"]` overrides and a `.grid.compact` density variant. Match existing CSS-variable conventions in the file.

**Step 4: Manual verification**

Run: `bun run build:web && bun run dev`
Open the dashboard. Verify:
- Gear opens the panel; display toggles change the grid instantly and survive reload (localStorage).
- Changing stale timeout / category mapping / summary settings echoes back (panel reflects server state) and a second browser tab updates live.
- A category mapping change re-roles sessions in the grid without waiting for the next report.

**Step 5: Commit**

```bash
git add packages/web/src/App.tsx packages/web/src/Settings.tsx packages/web/src/styles.css
git commit -m "feat(web): settings slide-over panel + apply view prefs"
```

---

## Task 10: Full suite + docs

**Step 1: Run everything**

Run: `bun test`
Expected: all green (49 prior + new tests).

Run: `bunx tsc --noEmit`
Expected: clean.

**Step 2: Update README**

Add a short "Settings" subsection to `README.md`: where each tier persists (`localStorage`, `~/.mission-control/config.json`, pushed-to-reporter), and that `MC_*` env vars are now boot defaults overridable live. Note the `staleMs` 2000ms floor and the "summary model/enabled apply on reporter restart, min-interval live" caveat.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the settings page + config tiers"
```

---

## Notes for the implementer

- **Never break ingest:** all category compilation goes through `compileCwdRules` (try/catch). A bad regex must degrade to "no match", never throw.
- **Echo, don't guess:** the Settings panel renders server-accepted config from the `settings` broadcast — no optimistic local state for server settings.
- **YAGNI:** no per-host config, no scan-interval push, no auth changes this round — same unauthenticated `/ws/live` command posture as today's focus/kill/prompt.
- **Open scope question for review (Task 6):** live model/enabled swap for summaries is deferred to reporter restart; confirm acceptable or promote to a follow-up task.
