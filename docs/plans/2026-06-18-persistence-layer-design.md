# Persistence Layer Design

**Date:** 2026-06-18
**Status:** Design (pre-implementation)

## Goal

Mission Control is currently **memory-only** — the server holds live state, fans it out to browsers, and forgets everything on restart. Reporters push a full `HostReport` (~every 3s) that is broadcast and discarded.

This design taps that river once at the hub edge and writes a durable capture layer that serves three views from one store:

1. **Session registry + resume** — durable list of every session (id, provider, lifecycle state, cwd, last subject, A2A handle/nickname) so you can filter history, find a session, and **restart it with one click**.
2. **Time-series metrics** — sampled numeric state (tokens, cost, cpu/mem, context occupancy) over time for graphs.
3. **Event log / audit trail** — discrete transitions and A2A traffic as an immutable timeline to mine for future features.

## Design decisions (brainstorm outcomes)

| Decision | Choice |
|----------|--------|
| Scope | All three views, one store |
| Storage | `bun:sqlite`, single file `~/.mission-control/mc.db`, `:memory:` in tests |
| Write strategy | Sampled (coarse interval) **+** event-on-change |
| Session identity | `providerSessionId` when present, else synthetic `hostId:pid:startedAt` |
| Close detection | Diff snapshots; host-offline → `orphaned` (not `closed`) |
| Writer placement | `store.ts` module wired at the `index.ts` I/O edge; hub stays pure |
| Read surface | HTTP query endpoints + a minimal web History view |
| Retention | Tiered downsampling (never hard-delete samples); age ladder + size ceiling |
| Raw window | 15 days (valid only while `sampleInterval >= ~30-60s`) |

## Core principles preserved

- **Hub stays pure / transport-agnostic.** All disk I/O lives at the `index.ts` edge, same as today's `events.jsonl`.
- **Memory-only, self-healing for live state.** The DB is durable, but the Store's in-memory "previous snapshot" can be lost on restart with no worse cost than one missed transition (reporters re-report in ~3s).
- **`@mc/shared` is the schema.** New event types and the resume-command templates are contract and live there.

---

## Section 1 — Data model (SQLite schema)

One file `~/.mission-control/mc.db` (path derived from `MC_HOME`). WAL mode so web read queries don't block writes. `:memory:` for tests.

### `sessions` — the registry (one row per session, kept forever)

```
session_key          TEXT PRIMARY KEY   -- providerSessionId, else hostId:pid:startedAt
live_id              TEXT               -- last hostId:pid (correlate with live board)
resume_id            TEXT               -- the id a CLI resumes with (providerSessionId)
provider             TEXT
host_id              TEXT
host_label           TEXT
cwd                  TEXT
category             TEXT
model                TEXT
handle               TEXT               -- A2A routing tag, e.g. 'mc:a3' (sticky per pid)
display_name         TEXT               -- Haiku nickname, e.g. 'Falcon'
subject              TEXT
started_at           INTEGER
ended_at             INTEGER NULL
state                TEXT               -- 'running' | 'closed' | 'orphaned'
last_seen_at         INTEGER
-- running rollups so the list needs no sample join:
cost_usd             REAL
tokens_in            INTEGER
tokens_out           INTEGER
tokens_cache_read    INTEGER
tokens_cache_write   INTEGER
peak_context_tokens  INTEGER
tools_used           TEXT               -- JSON array
```

### `samples` — the firehose (downsampled as it ages)

```
session_key     TEXT
at              INTEGER
resolution      TEXT     -- 'raw' | 'hour' | 'day'
tokens_in       INTEGER
tokens_out      INTEGER
tokens_cache_read   INTEGER
tokens_cache_write  INTEGER
cost_usd        REAL
context_tokens  INTEGER
context_window  INTEGER
cpu             REAL
mem_mb          REAL
active          REAL     -- 0/1 at raw; duty-cycle fraction once condensed
PRIMARY KEY (session_key, at, resolution)
```

### `events` — discrete transitions + A2A traffic (time-windowed)

```
id          INTEGER PRIMARY KEY
at          INTEGER
session_key TEXT
type        TEXT     -- see union below
host_id     TEXT
pid         INTEGER
detail      TEXT     -- JSON, shape varies by type
```

### Indexes

```
samples(session_key, at)
events(at)
events(session_key)
sessions(state)
sessions(provider)
sessions(started_at)
```

### Event type union (in `@mc/shared`, extends existing `SessionEvent`)

- `session.started`, `session.closed`, `session.state` (`{from,to}`), `session.tool` (`{tool}`), `session.errored` (`{transient, ...}`)
- existing: `session.killed`, `session.prompted`
- A2A: `task.routed` (`{taskId, fromHandle, toHandle, fromKey, toKey, text}`), `task.replied` (`{taskId, reply, ok}`)

A2A `detail` always stores **both** the human-readable `handle` and the durable `session_key`; the handle number can recycle across reboots, so queries join on key, display shows the handle.

---

## Section 2 — Write path

`store.ts` exports a `Store` class owning the sqlite handle + diff/sample logic. `index.ts` wires it at the I/O edge.

### Hook points (`index.ts`)

```
after hub.ingest(report, now)      →  store.record(report, now)
on reporter drop / sweep offline   →  store.onHostOffline(hostId, now)
on existing SessionEvent           →  store.event(...)
on A2A router task create / reply  →  store.event('task.routed' | 'task.replied', ...)
```

### `store.record(report, now)`

Store keeps `Map<hostId, Map<sessionKey, Session>>` — the previous tick per host.

1. **Diff vs the host's previous snapshot:**
   - key present now, absent before → `session.started` event + registry insert (`state='running'`).
   - key present before, absent now → `session.closed` event + registry update (`state='closed'`, `ended_at=now`).
   - key in both → compare fields; emit `session.state` on `active`/`attention` flips, `session.errored` on error flip, `session.tool` for new `toolsUsed` entries.
2. **Registry upsert** for every live session: refresh `last_seen_at`, `live_id`, `handle`, `display_name`, `subject`, and running rollups (`cost_usd`, token totals, `peak_context_tokens = max(prev, contextTokens)`, union of `tools_used`).
3. **Sample gate:** write a `resolution='raw'` sample only if `now - lastSampleAt[sessionKey] >= sampleIntervalMs`. Throttled per session, independent of the 3s tick.

All writes per `record()` call batched in one transaction.

### `onHostOffline(hostId, now)`

Mark that host's still-`running` sessions `state='orphaned'` (not `closed` — the process may still live; we lost the reporter). If the host returns and the session reappears, flip back to `running`.

### Crash safety

The previous-snapshot map is in memory; a server restart loses pending diffs for one tick (worst case one missed transition — reporters re-report in ~3s). The DB is durable. Mirrors the existing self-healing ethos.

---

## Section 3 — Retention via tiered downsampling

Reuses the existing 2s sweep timer; `store.maybeCompact(now)` actually runs at most once per `compactIntervalMs` (default ~1h), cheap no-op otherwise.

### Age ladder — samples lose granularity, never disappear

```
raw   (full sampleInterval)   kept   rawDays   (default 15)
hour  (1 row/session/hour)    kept   hourDays  (default 90)
day   (1 row/session/day)     kept   forever
```

When raw samples cross `rawDays`, condense each `(session_key, hour-bucket)` into one `resolution='hour'` row, delete the raw rows that fed it; same raw→hour→day promotion. Aggregation per bucket:

- cumulative (`cost_usd`, token totals) → **last** value (monotonic; last = total at bucket end)
- gauges (`context_tokens`, `cpu`, `mem_mb`) → **avg**; keep `peak_context_tokens` as max
- `active` → fraction busy (0..1), a duty-cycle signal at coarse resolution

### Size ceiling — second, independent knob

If `db bytes > maxBytes` (default ~500MB), promote the oldest still-raw tier early (before `rawDays`), oldest-first, until under budget. Size pressure dynamically shortens the raw window; age is steady-state. **`log()` when the size ceiling preempts the age ladder** so the shortened raw window is not a silent surprise.

> **Soft cap (implementation note):** `maxBytes` is a *soft* trigger, not a hard cap. Under WAL the compaction loop drains raw→hour while over budget, but the implementation intentionally does **not** `VACUUM`/checkpoint, so `page_count` (and on-disk size) won't actually shrink until a later checkpoint/VACUUM. In practice an over-budget run downsamples every raw row to hour resolution then stops — a safe degradation (data is downsampled, not lost), not a precise byte-target trim.

### Events & registry

- `events` (transitions + `task.*`) **hard-deleted** past `eventDays` (default 90) — discrete facts don't downsample meaningfully.
- `sessions` registry rows: never touched.

### Config (`AppConfig.retention`)

`{ sampleIntervalMs, rawDays, hourDays, eventDays, maxBytes, compactIntervalMs, orphanCloseDays }` — editable in the Settings panel, round-tripped like other server config.

> Coupling note: `rawDays=15` stays cheap only while `sampleIntervalMs >= ~30-60s`. At a fine interval the size ceiling wins and the effective raw window shrinks (logged).

---

## Section 4 — Read API + History view

### HTTP endpoints (on the existing `Bun.serve`)

Read-only JSON; live board stays on WebSocket, history is pull.

```
GET /api/sessions
    ?state= &provider= &category= &cwd= &since= &until= &limit= &offset=
    → registry rows (no sample join)

GET /api/sessions/:key
    → full registry row + recent events for that session

GET /api/sessions/:key/samples?since=&until=&resolution=auto
    → time-series; resolution=auto picks raw/hour/day from the range span

GET /api/events?type=&sessionKey=&since=&until=&limit=
    → discrete timeline (transitions + task.routed/replied)
```

`resolution=auto`: range ≤ `rawDays` → raw; ≤ `hourDays` → hour; else day. Server hides the tiering behind one param.

### History view (React)

New lazy tab/route in `App.tsx`; a `useHistory` hook does plain `fetch` (no WS, does not touch the live `useLive` reducer).

- **List:** closed/orphaned sessions, filterable by the same facets as the live board (provider, category, host, search). Each row shows nickname + handle, provider, cwd, duration, total cost, tokens.
- **Restart command — copy to clipboard.** Each row has a clipboard icon that copies the **full provider-specific resume command**, not just the id.
- **Detail (expand/drawer):** sparkline of `cost_usd` / `tokens` / `context_tokens` over the session's life (samples endpoint) + event timeline (tools, state flips, A2A messages).

Reuses existing filter/search UI and card styling.

### Resume command (in `@mc/shared`)

`resumeCommand(session)` builds a provider-specific string from `{provider, resume_id, cwd}`:

```
claude    → cd <cwd> && claude --resume <resume_id>
codex     → cd <cwd> && codex resume <resume_id>
opencode  → cd <cwd> && opencode --session <resume_id>   (VERIFY flag)
pi        → cd <cwd> && pi ... <resume_id>                (VERIFY)
fallback  → <resume_id>   (when no template / no resume_id)
```

Where a provider has no native resume id (synthetic-key sessions), the icon is **disabled with a tooltip** ("no resume id for this provider") rather than copying a broken command. The `cd <cwd> &&` prefix lands the paste in the right project.

> Build-time TODO: verify the exact resume flag per installed CLI (`--resume` vs `resume` vs `--session`) — do not guess.

---

## End-to-end

```
reporter --HostReport ~3s--> hub.ingest (pure) --patch--> browser (live)
                                   │
                          index.ts edge
                                   │
                          store.record(report, now)
                             ├─ diff → events
                             ├─ registry upsert (+ handle, nickname, rollups)
                             └─ sample gate → samples(raw)
                                   │
                          store.maybeCompact (hourly)
                             ├─ age ladder: raw→hour→day
                             └─ size ceiling: early promote (soft cap, no VACUUM)
                                   │
                          HTTP /api/* ──fetch──> History view (registry, samples, events, resume cmd)
```

## Implementation order (suggested)

1. `@mc/shared`: event-type union additions, `AppConfig.retention`, `resumeCommand()`.
2. `store.ts` + tests against `:memory:` (diff logic, sample gate, rollup math — pure-function-first).
3. Wire `store.record` / `onHostOffline` / `event` into `index.ts`.
4. `maybeCompact` retention (age ladder, then size ceiling).
5. HTTP `/api/*` endpoints.
6. Web History view + `useHistory` + clipboard resume.
