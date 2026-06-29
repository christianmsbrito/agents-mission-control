# Persistence Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a durable SQLite capture layer at the server hub edge that records every agent session's lifecycle (registry), time-series metrics (samples), and discrete transitions + A2A traffic (events) — then serves it over HTTP to a web History view with one-click resume-command copy.

**Architecture:** A new `packages/server/src/store.ts` owns a `bun:sqlite` handle and all diff/sample/rollup logic as pure-ish methods. `index.ts` calls it at the same I/O edge where `events.jsonl` is written today, keeping `hub.ts` pure. Reads are plain JSON HTTP endpoints on the existing `Bun.serve`. The web History view fetches them (no WebSocket).

**Tech Stack:** Bun, `bun:sqlite` (built-in), TypeScript with explicit `.ts` import extensions, React 19, `*.test.ts` colocated, `:memory:` DB for tests.

**Companion design doc:** `docs/plans/2026-06-18-persistence-layer-design.md` (read it for rationale).

**Conventions to honor (from CLAUDE.md / architecture.md):**
- Keep `hub.ts` transport-agnostic; all disk I/O lives in `index.ts` / `store.ts`.
- Pure-function-first tests; side-effects at the edges.
- `@mc/shared` is the schema — wire-type changes go there and ripple out.
- Imports carry explicit `.ts` extensions.
- Commit after each task. Run `bun test` before each commit.

---

## Task 1: Shared — event types, persisted types, retention config, resume command

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts` (export new helper if not already `export *`)
- Test: `packages/shared/src/shared.test.ts`

**Step 1: Write failing tests**

Add to `packages/shared/src/shared.test.ts`:

```ts
import { resumeCommand } from "./types.ts";

describe("resumeCommand", () => {
  test("claude builds a --resume command scoped to cwd", () => {
    expect(resumeCommand({ provider: "claude", resumeId: "abc-123", cwd: "/repo" }))
      .toBe("cd /repo && claude --resume abc-123");
  });
  test("codex uses positional resume", () => {
    expect(resumeCommand({ provider: "codex", resumeId: "uuid-9", cwd: "/x" }))
      .toBe("cd /x && codex resume uuid-9");
  });
  test("missing resumeId yields null (icon disabled)", () => {
    expect(resumeCommand({ provider: "opencode", resumeId: undefined, cwd: "/x" }))
      .toBeNull();
  });
  test("unknown provider falls back to bare id", () => {
    expect(resumeCommand({ provider: "mystery", resumeId: "z", cwd: null }))
      .toBe("z");
  });
});
```

**Step 2: Run test, verify it fails**

Run: `bun test packages/shared/src/shared.test.ts -t resumeCommand`
Expected: FAIL — `resumeCommand is not a function`.

**Step 3: Implement in `types.ts`**

Append these types + helper to `packages/shared/src/types.ts`:

```ts
// --- Persistence layer ---

/** Lifecycle state of a persisted session in the registry. */
export type PersistedSessionState = "running" | "closed" | "orphaned";

/** A registry row: one per session, kept forever. */
export type PersistedSession = {
  sessionKey: string;          // providerSessionId, else `${hostId}:${pid}:${startedAt}`
  liveId: string;              // last `${hostId}:${pid}`
  resumeId?: string;           // provider-native id a CLI resumes with
  provider: string;
  hostId: string;
  hostLabel: string;
  cwd: string | null;
  category: string;
  model?: string;
  handle?: string;             // A2A routing tag, e.g. "mc:a3"
  displayName?: string;        // Haiku nickname
  subject?: string;
  startedAt: number;
  endedAt?: number;
  state: PersistedSessionState;
  lastSeenAt: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  peakContextTokens?: number;
  toolsUsed?: string[];
};

/** A time-series sample row. */
export type SessionSample = {
  sessionKey: string;
  at: number;
  resolution: "raw" | "hour" | "day";
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  costUsd?: number;
  contextTokens?: number;
  contextWindow?: number;
  cpu?: number;
  memMb?: number;
  active?: number;             // 0/1 raw; duty-cycle fraction once condensed
};

/** Discrete event types persisted to the events table. Extends the live SessionEvent union. */
export type PersistedEventType =
  | "session.started"
  | "session.closed"
  | "session.state"
  | "session.tool"
  | "session.errored"
  | "session.killed"
  | "session.prompted"
  | "task.routed"
  | "task.replied";

export type PersistedEvent = {
  at: number;
  sessionKey: string;
  type: PersistedEventType;
  hostId?: string;
  pid?: number;
  detail?: Record<string, unknown>;
};

/** Retention policy — all editable in the Settings panel. */
export type RetentionConfig = {
  sampleIntervalMs: number;    // gate between raw samples per session
  rawDays: number;             // keep raw resolution this long (default 15)
  hourDays: number;            // keep hourly resolution this long (default 90)
  eventDays: number;           // hard-delete events older than this (default 90)
  maxBytes: number;            // size ceiling (soft cap; preempts age ladder, default ~500MB)
  compactIntervalMs: number;   // min gap between compaction runs (default ~1h)
  orphanCloseDays: number;     // after this many days, a still-orphaned session is reconciled to closed (default 7)
};

const RESUME_TEMPLATES: Record<string, (id: string, cwd: string | null) => string> = {
  claude: (id, cwd) => prefixCwd(cwd, `claude --resume ${id}`),
  codex: (id, cwd) => prefixCwd(cwd, `codex resume ${id}`),
  opencode: (id, cwd) => prefixCwd(cwd, `opencode --session ${id}`), // VERIFY flag
  pi: (id, cwd) => prefixCwd(cwd, `pi --resume ${id}`),               // VERIFY flag
};

function prefixCwd(cwd: string | null, cmd: string): string {
  return cwd ? `cd ${cwd} && ${cmd}` : cmd;
}

/** Build a provider-specific resume command, or null when there is no resume id. */
export function resumeCommand(s: { provider: string; resumeId?: string; cwd: string | null }): string | null {
  if (!s.resumeId) return null;
  const tmpl = RESUME_TEMPLATES[s.provider];
  return tmpl ? tmpl(s.resumeId, s.cwd) : s.resumeId;
}
```

Then extend `AppConfig` in the same file — add a `retention: RetentionConfig` field.

**Step 4: Run tests, verify pass**

Run: `bun test packages/shared/src/shared.test.ts`
Expected: PASS.

**Step 5: Wire retention defaults into `config.ts`**

In `packages/server/src/config.ts`, add to `defaultConfig`:

```ts
retention: {
  sampleIntervalMs: Number(env.MC_SAMPLE_INTERVAL_MS || 60_000),
  rawDays: Number(env.MC_RETAIN_RAW_DAYS || 15),
  hourDays: Number(env.MC_RETAIN_HOUR_DAYS || 90),
  eventDays: Number(env.MC_RETAIN_EVENT_DAYS || 90),
  maxBytes: Number(env.MC_RETAIN_MAX_BYTES || 500_000_000),
  compactIntervalMs: Number(env.MC_COMPACT_INTERVAL_MS || 3_600_000),
  orphanCloseDays: Number(env.MC_RETAIN_ORPHAN_CLOSE_DAYS || 7),
},
```

Add `retention: over.retention ?? base.retention` to `mergeConfig`. Run `bun test packages/server` to confirm config tests still pass; fix any AppConfig type errors that surface.

**Step 6: Commit**

```bash
git add packages/shared packages/server/src/config.ts
git commit -m "feat(shared): persistence types, retention config, resumeCommand"
```

---

## Task 2: Store — open DB + schema migration

**Files:**
- Create: `packages/server/src/store.ts`
- Test: `packages/server/src/store.test.ts`

**Step 1: Write failing test**

```ts
import { test, expect, describe } from "bun:test";
import { Store } from "./store.ts";

describe("Store schema", () => {
  test("opens :memory: and creates the three tables", () => {
    const store = new Store(":memory:");
    const tables = store.db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["events", "samples", "sessions"]));
    store.close();
  });
});
```

**Step 2: Run, verify fail** — `bun test packages/server/src/store.test.ts` → FAIL (no `store.ts`).

**Step 3: Implement minimal `Store`**

```ts
import { Database } from "bun:sqlite";

export class Store {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY, live_id TEXT, resume_id TEXT,
        provider TEXT, host_id TEXT, host_label TEXT, cwd TEXT,
        category TEXT, model TEXT, handle TEXT, display_name TEXT, subject TEXT,
        started_at INTEGER, ended_at INTEGER, state TEXT, last_seen_at INTEGER,
        cost_usd REAL, tokens_in INTEGER, tokens_out INTEGER,
        tokens_cache_read INTEGER, tokens_cache_write INTEGER,
        peak_context_tokens INTEGER, tools_used TEXT
      );
      CREATE TABLE IF NOT EXISTS samples (
        session_key TEXT, at INTEGER, resolution TEXT,
        tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER,
        tokens_cache_write INTEGER, cost_usd REAL, context_tokens INTEGER,
        context_window INTEGER, cpu REAL, mem_mb REAL, active REAL,
        PRIMARY KEY (session_key, at, resolution)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, session_key TEXT,
        type TEXT, host_id TEXT, pid INTEGER, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_samples_key_at ON samples(session_key, at);
      CREATE INDEX IF NOT EXISTS ix_events_at ON events(at);
      CREATE INDEX IF NOT EXISTS ix_events_key ON events(session_key);
      CREATE INDEX IF NOT EXISTS ix_sessions_state ON sessions(state);
      CREATE INDEX IF NOT EXISTS ix_sessions_provider ON sessions(provider);
      CREATE INDEX IF NOT EXISTS ix_sessions_started ON sessions(started_at);
    `);
  }
  close(): void { this.db.close(); }
}
```

**Step 4: Run, verify pass.**

**Step 5: Commit**

```bash
git add packages/server/src/store.ts packages/server/src/store.test.ts
git commit -m "feat(store): sqlite handle + schema migration"
```

---

## Task 3: Store — sessionKey derivation + registry upsert

**Files:** Modify `store.ts`; Test `store.test.ts`.

**Step 1: Write failing tests**

```ts
import { sessionKeyOf } from "./store.ts";

describe("sessionKeyOf", () => {
  test("prefers providerSessionId", () => {
    expect(sessionKeyOf({ providerSessionId: "P9", hostId: "h", pid: 5, startedAt: 1 } as any)).toBe("P9");
  });
  test("synthesizes when no providerSessionId", () => {
    expect(sessionKeyOf({ hostId: "h", pid: 5, startedAt: 1 } as any)).toBe("h:5:1");
  });
});

describe("Store.record registry", () => {
  test("inserts a running session and updates rollups across ticks", () => {
    const store = new Store(":memory:");
    const base = { id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H",
      cwd: "/r", category: "code", startedAt: 1000, cpu: 0, memMb: 0, providerSessionId: "P9" };
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1000,
      sessions: [{ ...base, costUsd: 0.1, tokensOut: 10, toolsUsed: ["bash"] }] } as any, 1000);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 2000,
      sessions: [{ ...base, costUsd: 0.3, tokensOut: 40, toolsUsed: ["bash", "edit"] }] } as any, 2000);
    const row: any = store.db.query("SELECT * FROM sessions WHERE session_key='P9'").get();
    expect(row.state).toBe("running");
    expect(row.cost_usd).toBe(0.3);
    expect(JSON.parse(row.tools_used).sort()).toEqual(["bash", "edit"]);
    expect(row.last_seen_at).toBe(2000);
    store.close();
  });
});
```

**Step 2: Run, verify fail.**

**Step 3: Implement** `sessionKeyOf(session)` and the registry-upsert portion of `record(report, now)`. For each session in the report: derive key, `INSERT … ON CONFLICT(session_key) DO UPDATE` setting `state='running'`, `last_seen_at=now`, `live_id`, `handle`, `display_name`, `subject`, `model`, `category`, and rollups (`cost_usd`, token totals = latest values; `peak_context_tokens = max(existing, contextTokens)`; `tools_used` = JSON union of existing + new). Keep `record()` doing only registry work for now; diff/sample come next. Wrap the per-report writes in `this.db.transaction(...)`.

**Step 4: Run, verify pass. Step 5: Commit** `feat(store): sessionKey derivation + registry upsert`.

---

## Task 4: Store — snapshot diffing → events

**Files:** Modify `store.ts`; Test `store.test.ts`.

**Step 1: Write failing tests** covering: (a) first sight of a key emits `session.started`; (b) a key present last tick but absent now emits `session.closed` and sets `state='closed'`, `ended_at`; (c) an `active` false→true flip emits `session.state` with `detail={from:false,to:true}`; (d) a new tool in `toolsUsed` emits `session.tool` with `detail={tool}`; (e) `errored` flip emits `session.errored`.

```ts
test("started then closed across ticks", () => {
  const store = new Store(":memory:");
  const s = { id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H",
    cwd: "/r", category: "code", startedAt: 1, cpu: 0, memMb: 0, providerSessionId: "P9" };
  store.record({ hostId: "h", hostLabel: "H", sentAt: 1, sessions: [s] } as any, 1);
  store.record({ hostId: "h", hostLabel: "H", sentAt: 2, sessions: [] } as any, 2);
  const types = store.db.query("SELECT type FROM events ORDER BY id").all().map((r: any) => r.type);
  expect(types).toEqual(["session.started", "session.closed"]);
  const row: any = store.db.query("SELECT state, ended_at FROM sessions WHERE session_key='P9'").get();
  expect(row.state).toBe("closed");
  expect(row.ended_at).toBe(2);
  store.close();
});
```

**Step 2: Run, verify fail.**

**Step 3: Implement.** Add a private `prevByHost: Map<string, Map<string, Session>>`. In `record`, build the current key→session map for the report's host, diff against `prevByHost.get(hostId)`:
- new keys → `session.started`.
- vanished keys → `session.closed` (+ registry `state='closed'`, `ended_at=now`).
- common keys → compare `active`, `attention`, `errored` (emit `session.state` / `session.errored` on change) and `toolsUsed` set-difference (emit `session.tool` per new tool).
Then store the current map as the new `prev`. Insert events via a prepared statement inside the same transaction.

**Step 4: Run, verify pass. Step 5: Commit** `feat(store): snapshot diff -> lifecycle events`.

---

## Task 5: Store — sample gate

**Files:** Modify `store.ts`; Test `store.test.ts`.

**Step 1: Write failing test** — with `sampleIntervalMs=60_000`, two `record()` calls 30s apart produce **one** raw sample for the session; a third call 60s after the first produces a second. Sample row carries `cost_usd`, `tokens_*`, `context_tokens`, `cpu`, `mem_mb`, `active` (1/0), `resolution='raw'`.

```ts
test("sample gate throttles per session", () => {
  const store = new Store(":memory:", { sampleIntervalMs: 60_000 } as any);
  const s = (t: number) => ({ id: "h:5", provider: "claude", pid: 5, hostId: "h",
    hostLabel: "H", cwd: "/r", category: "code", startedAt: 1, cpu: 1, memMb: 2,
    providerSessionId: "P9", costUsd: 0.1, active: true });
  store.record({ hostId: "h", hostLabel: "H", sentAt: 0, sessions: [s(0)] } as any, 0);
  store.record({ hostId: "h", hostLabel: "H", sentAt: 30_000, sessions: [s(30_000)] } as any, 30_000);
  store.record({ hostId: "h", hostLabel: "H", sentAt: 60_000, sessions: [s(60_000)] } as any, 60_000);
  const n = store.db.query("SELECT COUNT(*) c FROM samples WHERE resolution='raw'").get() as any;
  expect(n.c).toBe(2);
  store.close();
});
```

**Step 2: Run, verify fail.**

**Step 3: Implement.** Constructor takes an optional `opts: { sampleIntervalMs?: number }` (default 60_000). Keep `lastSampleAt: Map<string, number>`. In `record`, after registry/diff, for each live session insert a raw sample iff `now - (lastSampleAt.get(key) ?? -Infinity) >= sampleIntervalMs`, then set `lastSampleAt`.

**Step 4: Run, verify pass. Step 5: Commit** `feat(store): per-session sample gate`.

---

## Task 6: Store — onHostOffline orphaning + revival

**Files:** Modify `store.ts`; Test `store.test.ts`.

**Step 1: Write failing tests** — after a running session, `onHostOffline("h", now)` sets its `state='orphaned'` (not `closed`, `ended_at` stays null). A subsequent `record()` with the session present flips it back to `running`. Sessions already `closed` are not revived by `onHostOffline`.

**Step 2: Run, verify fail.**

**Step 3: Implement** `onHostOffline(hostId, now)`: `UPDATE sessions SET state='orphaned', last_seen_at=? WHERE host_id=? AND state='running'`. Drop the host from `prevByHost` so a revival registers cleanly. Revival is automatic via the existing upsert (`state='running'`). Closed stays closed (filter `state='running'` in the orphan update).

**Step 4: Run, verify pass. Step 5: Commit** `feat(store): host-offline orphaning + revival`.

---

## Task 7: Store — retention compaction (age ladder + size ceiling)

**Files:** Modify `store.ts`; Test `store.test.ts`.

**Step 1: Write failing tests** for pure helpers first:
- `hourBucket(ms)` / `dayBucket(ms)` floor to the hour/day.
- `condense(samples)` over a bucket returns cumulative=last, gauges=avg, active=fraction.
Then an integration test: seed raw samples older than `rawDays`, call `compact(now)`, assert raw rows gone and one `hour` row per (key,hour) with condensed values. Seed hour rows older than `hourDays`, assert promotion to `day`. Events older than `eventDays` are deleted; registry rows untouched.

**Step 2: Run, verify fail.**

**Step 3: Implement** `compact(now)`:
1. Promote raw → hour for raw samples with `at < now - rawDays`: group by `(session_key, hourBucket(at))`, insert condensed `resolution='hour'` rows, delete the consumed raw rows.
2. Promote hour → day for hour samples with `at < now - hourDays`.
3. `DELETE FROM events WHERE at < now - eventDays`.
4. Reconcile stale orphans: `UPDATE sessions SET state='closed', ended_at=last_seen_at WHERE state='orphaned' AND last_seen_at < now - orphanCloseDays` — a host that never came back means those processes are dead; `ended_at=last_seen_at` is the best death-time estimate. Running/closed/within-window rows untouched.
5. Size ceiling (**soft cap**): if `pageCount*pageSize > maxBytes`, repeatedly promote the oldest still-raw bucket early until under budget; `log`/return a flag when this preempts the age ladder. (`log` = console here; the index.ts caller decides surfacing.) NOTE: under WAL the implementation intentionally does **not** VACUUM/checkpoint, so `page_count` won't shrink mid-loop — an over-budget run drains all raw rows to hour resolution then stops (safe degradation, not a precise byte target).
Add `maybeCompact(now)`: run `compact` only if `now - lastCompactAt >= compactIntervalMs`. Constructor opts gain the full `RetentionConfig`.

**Step 4: Run, verify pass. Step 5: Commit** `feat(store): tiered downsampling + size-ceiling compaction`.

---

## Task 8: Store — query methods for the read API

**Files:** Modify `store.ts`; Test `store.test.ts`.

**Step 1: Write failing tests** for: `listSessions(filter)` (by state/provider/category/cwd/time window, with limit/offset, newest first); `getSession(key)` (row + recent events); `getSamples(key, {since, until, resolution})` with `resolution:"auto"` picking raw/hour/day by span; `listEvents(filter)`.

**Step 2: Run, verify fail.**

**Step 3: Implement** these as parameterized `db.query(...).all()` methods returning camelCase-mapped `PersistedSession` / `SessionSample` / `PersistedEvent` objects. `auto` resolution: `span <= rawDays → raw`, `<= hourDays → hour`, else `day`.

**Step 4: Run, verify pass. Step 5: Commit** `feat(store): registry/sample/event query methods`.

---

## Task 9: Wire Store into the server edge (`index.ts`)

**Files:** Modify `packages/server/src/index.ts`; Test `packages/server/src/server.test.ts`.

**Step 1: Write failing test** — boot the server (as `server.test.ts` already does), send a `hello` + a `report` over `/ws/report`, then assert the store has a `running` session row. Use a `:memory:`/temp store. (If the singleton store makes injection hard, expose the module-level `store` via the existing `export { server, hub }` → add `store`.)

**Step 2: Run, verify fail.**

**Step 3: Implement.** Construct `const store = new Store(DB_FILE, config.retention)` where `DB_FILE = join(homedir(), ".mission-control", "mc.db")` (ensure dir via the existing mkdir pattern). Hooks:
- after `hub.ingest(msg.report, Date.now())` → `store.record(msg.report, Date.now())`.
- in `close()` for a `report` socket (host drop) and in a wrapper around `hub.sweep` → `store.onHostOffline(hostId, now)`. (Sweep currently calls `hub.sweep`; add `store` orphaning for each host the sweep drops — simplest: have the 2s timer also call `store.maybeCompact(Date.now())`, and call `store.onHostOffline` from the same place `hub.dropHost` is triggered.)
- on the existing `session.killed` / `session.prompted` `publishEvent` calls → also `store.event({...})` with the derived `sessionKey`. Keep `events.jsonl` writing as-is (dual-write during transition).
Guard every store call in try/catch — persistence must never break live reporting (mirror the `publishEvent` best-effort contract).

**Step 4: Run `bun test packages/server`, verify pass. Step 5: Commit** `feat(server): wire Store at the ingest/offline/event edge`.

---

## Task 10: Wire A2A task events

**Files:** Modify `packages/server/src/index.ts` (wherever router `AgentTask` create/reply happens — search for `buildAskPrompt` / task creation in the A2A flow); Test `server.test.ts`.

**Step 1: Write failing test** — drive a routed task through the existing A2A path and assert a `task.routed` event row exists with `detail.taskId`, `detail.fromHandle`, `detail.toHandle`, and durable `fromKey`/`toKey`; on reply, a `task.replied` row.

**Step 2: Run, verify fail.**

**Step 3: Implement** `store.event("task.routed", …)` at task creation and `store.event("task.replied", …)` at reply delivery, resolving each side's `sessionKey` from the live `Session` (via `hub.findSession*`) so `detail` carries both handle and key. Best-effort try/catch.

**Step 4: Run, verify pass. Step 5: Commit** `feat(server): persist A2A task.routed/replied events`.

---

## Task 11: HTTP read endpoints

**Files:** Modify `packages/server/src/index.ts`; Test `server.test.ts`.

**Step 1: Write failing tests** — `GET /api/sessions?state=closed` returns JSON array; `GET /api/sessions/:key` returns the row + events; `GET /api/sessions/:key/samples` returns samples; `GET /api/events` returns events. Use the running test server + a seeded store.

**Step 2: Run, verify fail.**

**Step 3: Implement** route handlers in the `fetch` block (before the static-file fallback): parse `URL.searchParams`, call the Task 8 query methods, `Response.json(...)`. Keep them read-only; no auth (same trust model as `/ws/live`). Add a `/api/` path guard so SPA fallback doesn't swallow them.

**Step 4: Run `bun test packages/server`, verify pass. Step 5: Commit** `feat(server): /api/sessions + /api/events read endpoints`.

---

## Task 12: Web — History view + useHistory + clipboard resume

**Files:**
- Create: `packages/web/src/useHistory.ts`
- Create: `packages/web/src/History.tsx`
- Modify: `packages/web/src/App.tsx` (add a History tab/route toggle)
- Modify: `packages/web/src/styles.css` (minimal styles, reuse existing tokens)

**Step 1: Write failing test (hook logic)** — if a pure helper is extractable (e.g. a `historyQueryString(filter)` builder), unit-test it in `packages/web/src/web.test.ts` (or colocated). UI rendering itself is not unit-tested here (no DOM test harness in repo); keep logic pure + tested, render thin.

**Step 2: Run, verify fail.**

**Step 3: Implement.**
- `useHistory(filter)`: `fetch('/api/sessions?' + historyQueryString(filter))`, returns `{ sessions, loading, error, refetch }`. A second fetcher for `/api/sessions/:key` detail + `/api/sessions/:key/samples`.
- `History.tsx`: a list reusing the existing filter/search UI (provider/category/host) showing closed+orphaned sessions: nickname + handle, provider, cwd, duration (`endedAt-startedAt`), total cost, tokens. A clipboard button per row calling `navigator.clipboard.writeText(resumeCommand({provider, resumeId, cwd}))` with a brief "copied" tick; **disabled with a title tooltip** when `resumeCommand(...)` is null. Row expand → sparkline of cost/tokens/contextTokens from the samples endpoint + an event timeline.
- `App.tsx`: a top-level Live/History toggle; History is lazy and does not mount `useLive`.

**Step 4: Build + manual check**

Run: `bun run build:web` (must succeed). Then `bun run dev`, open the UI, switch to History, confirm closed sessions list and the copy button copies the expected command. @superpowers:verification-before-completion — capture the actual copied string, don't assert blind.

**Step 5: Commit** `feat(web): History view with metrics + one-click resume`.

---

## Task 13: Docs + architecture update

**Files:** Modify `CLAUDE.md`, `architecture.md`, `README.md`.

**Step 1:** Document the Store (new package file, the edge-wiring rule, the three tables), the retention knobs + env vars, and the `/api/*` endpoints. Note the dual-write of events (jsonl + sqlite) and whether jsonl is now redundant (decide: keep both, or drop jsonl in a follow-up — do NOT remove in this branch).

**Step 2: Commit** `docs: persistence layer (store, retention, api, history view)`.

---

## Final verification (before finishing the branch)

- `bun test` → all green (existing 79 + new store/server/shared tests).
- `bun run build:web` → succeeds.
- `bun run dev` → start an agent, see it on Live; close it, see it move to History with a working resume-command copy.
- `bunx tsc` → no new type errors.
- Confirm `~/.mission-control/mc.db` is created and `git status` is clean (db lives under `$HOME`, never in repo).

Then use **superpowers:finishing-a-development-branch** to merge/PR.

## Risks / open verifications (resolve during implementation, do not guess)

- **Resume flags** per CLI (`opencode --session`?, `pi --resume`?) — verify against installed binaries; fall back to bare id if unknown.
- **Multiple sessions sharing a cwd** report identical enrichment (known limitation) → their synthetic keys still differ by pid/startedAt, but providerSessionId-less providers may collapse. Acceptable for v1; note it.
- **WAL files** (`mc.db-wal`, `mc.db-shm`) appear next to the db under `$HOME` — fine, outside repo.
- **Sample volume vs rawDays=15** only safe while `sampleIntervalMs >= ~30-60s` (size ceiling otherwise preempts — Task 7 logs it).
