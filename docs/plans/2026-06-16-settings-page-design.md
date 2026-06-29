# Settings Page Design

**Date:** 2026-06-16
**Status:** Approved, ready for implementation

## Goal

Add a settings surface to the Mission Control dashboard so the configurable
knobs of the app can be tweaked live, without editing env vars and restarting
processes.

## Scope

Three tiers of settings, matching the three processes:

1. **Browser-view prefs** (localStorage, per-browser, no backend): theme,
   cost/token visibility, sort order, card density, filters (by
   category/provider/host + show-offline).
2. **Server-runtime config** (persisted on the server host): `staleMs`
   (offline timeout) and `categories` (role mapping). Editable live.
3. **Reporter config** (pushed from server): `summaries` settings
   (enabled/model/min-interval), delivered over the existing command channel.

Out of scope: per-host overrides, scan-interval push (trivial future add via the
same `config` message), authentication changes.

## Architecture context

The system is a one-way data river: `reporter --HostReport--> server --state-->
web`. Server state is in-memory only. **Commands** already flow back
server -> reporter (`focus`/`kill`/`prompt` via `ServerToReporterMsg`), so
pushing reporter config is an extension of that established channel, not a new
river. The "nothing flows back to reporters" rule applies to the state/data
river, not commands.

**Category ownership moves to the server.** The reporter still resolves category
as a harmless default, but `hub.ingest()` re-resolves from `provider`+`cwd`
using the server's mapping, overriding it. One place to change roles fleet-wide.

## Storage tiers

| Tier | Settings | Storage | Persistence |
|------|----------|---------|-------------|
| Browser | theme, cost/token visibility, sort, density, filters | `localStorage["mc.prefs"]` | per-browser |
| Server | `staleMs`, `categories` | `~/.mission-control/config.json` | survives restart |
| Reporter | `summaries` | pushed, in-memory | resets to env on reporter restart until re-pushed |

The server config file is the source of truth. The reporter copy is a runtime
override; on reporter restart it falls back to env defaults until the server
re-pushes on `hello`.

## Wire protocol additions (all additive)

Shared `AppConfig` type (`@mc/shared`):

```ts
export type AppConfig = {
  staleMs: number;
  categories: SerializableCategoryConfig; // byCwd match is string, not RegExp
  summaries: { enabled: boolean; model: string; minIntervalMs: number };
};
```

`byCwd` regex stored as a **string pattern**, compiled with `new RegExp(p)` at
use sites behind a shared safe-compile helper. A bad pattern is caught and
skipped — never throws into ingest.

- **Server -> Web** (`LiveMsg` gains): `SettingsMsg = { type: "settings"; config: AppConfig }`.
  Sent once on `/ws/live` connect (with initial `state`) and broadcast to all
  live clients on any config change.
- **Web -> Server** (`WebToServerMsg` gains): `SetSettingsRequest = { type: "set-settings"; patch: Partial<AppConfig> }`.
  Deep-merged, so the UI can save one field.
- **Server -> Reporter** (`ServerToReporterMsg` gains): `ConfigMsg = { type: "config"; summaries: AppConfig["summaries"] }`.
  Only summary settings cross to reporters.
- **Reporter -> Server:** no change.

## Server apply logic

**Boot:** `loadAppConfig()` reads `config.json` if present, deep-merges over env
defaults, returns `AppConfig` held in a mutable module-level `let config`. Hub
constructed with `config.staleMs`.

**Hub changes (stay transport-agnostic, unit-testable):**
- `staleMs` settable via `hub.setStaleMs(n)`; `sweep()` reads the live value.
- Hub constructed with a `getCategories: () => SerializableCategoryConfig`
  accessor; `ingest()` re-runs `resolveCategory(s.provider, s.cwd, undefined,
  categories)` per session, overwriting `s.category` before storing.

**`set-settings` handler** (one new branch in the `/ws/live` message switch,
beside `focus`/`kill`/`prompt`):
1. Deep-merge `patch` into `config`.
2. Persist to `config.json` — best-effort try/catch (like `publishEvent`).
3. Apply side-effects by what changed:
   - `staleMs` -> `hub.setStaleMs()`
   - `categories` -> re-resolve current snapshot in-memory + rebroadcast so the
     change is instant (cheap), and next `ingest()` picks it up via the accessor.
   - `summaries` -> push `{type:"config", summaries}` to every connected reporter.
4. Broadcast `{type:"settings", config}` to all live clients.

**On reporter `hello`:** after registering, send the current
`{type:"config", summaries}` so restarts re-sync.

## Reporter changes

Add a `config` branch to the existing server-command handler:

```ts
if (msg.type === "config") { cfg.summaries = msg.summaries; return; }
```

`cfg` is the live `ReporterConfig` the summarizer closes over — next summary
tick respects the change. No restart. `byCwd` string->RegExp compilation uses
the shared safe-compile helper.

## Web UI

Gear icon in the header opens a **slide-over panel** (not a separate route — keeps
the WS connection and grid mounted). Two groups:

- **Display** (localStorage via `usePrefs()`): theme select, cost/token toggles,
  sort dropdown, density toggle, filter checkboxes for
  categories/providers/hosts + show-offline. Applied in `App.tsx` render —
  instant, no network. Filter option lists derive from live data.
- **Server & fleet** (from `settings` LiveMsg): stale-timeout number input,
  category mapping editor (byProvider rows: provider->category; byCwd rows:
  pattern->category), summary enabled/model/min-interval. Each save fires
  `set-settings` with a partial patch through `useLive`'s send channel. Panel
  reflects the broadcast `settings` echo (server's accepted state, not optimistic
  local guesses).

`useLive.ts` grows a `config` state field (set from `settings` msgs) and a
`setSettings(patch)` sender. `App.tsx` filters/sorts the host list through
`prefs` before grouping.

## Error handling

- **Bad regex in `byCwd`:** safe-compile helper returns `null` on throw;
  `resolveCategory` skips null rules. Can't break `ingest()`.
- **Config file unreadable/corrupt at boot:** `loadAppConfig()` catches, logs,
  falls back to env defaults.
- **Config file unwritable on save:** best-effort try/catch; in-memory change +
  broadcast still happen, only persistence is lost.
- **`set-settings` validation:** clamp/whitelist before applying — `staleMs`
  floor (>= 2000ms so sweep can't thrash), ignore unknown keys. Reject silently
  like existing command guards.
- **Reporter offline when summaries change:** push is fire-and-forget; `hello`
  re-push covers reconnect. No queue, no retry.

## Testing (pure-function-first)

- `loadAppConfig()` merge: env + file -> expected `AppConfig` (injected file
  contents, no real fs).
- Safe-regex compile helper: valid compiles, invalid returns null.
- `applySettings(config, patch)` deep-merge + clamp: pure, table-tested.
- **Hub:** `ingest()` re-resolves category from passed mapping (category flips
  when mapping changes); `setStaleMs()` changes sweep behavior on next tick.
- Web `usePrefs` reducer: pure, testable without a DOM.

Side-effects (file write, reporter push, broadcast) stay thin in `index.ts`,
untested by unit tests — consistent with the repo.
