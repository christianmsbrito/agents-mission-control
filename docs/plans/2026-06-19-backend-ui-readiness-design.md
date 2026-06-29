# Backend UI-Readiness Design

**Date:** 2026-06-19
**Status:** Approved, pre-implementation
**Goal:** Make the backend ready to plug in a fully revamped frontend (live-first
hero + dashboards + drill-down + history + unified search), themed as a retro
RPG. This phase is **backend only** — no frontend work. Everything is additive;
the current web keeps working throughout.

## Context

The current UI is hard to filter/visualize, crams controls into the top navbar,
has ugly tabs, and a weak history mode. Before rewriting it we make the backend
expose the data shapes a good UI needs. See
`2026-06-15-agents-mission-control-design.md` (architecture) and
`2026-06-18-persistence-layer-design.md` (SQLite store) for background.

## Core architecture decision: no merge layer

The `sessions` table is **already the unified store**. Every reporter tick
upserts running sessions as `state='running'` rows (`store.ts` `upsertSession`,
`ON CONFLICT ... state='running'`); closed/orphaned rows coexist. So
"unified live+history" is just one SQL query over `sessions` that *includes*
running rows. Live-wins dedup is free (session_key upsert overwrites with the
newest). No new normalization/merge layer.

Two data planes stay separate, by role:

- **`/ws/live` (real-time plane)** — unchanged. Drives the live hero cards'
  sub-second updates and `focus`/`kill`/`prompt`. Live counts are computed
  **client-side** from this stream (no backend endpoint).
- **`/api/*` (query plane)** — extended here. Powers search, filters, sort,
  leaderboards, history, drill-down, dashboards. Authoritative for "all sessions
  ever, including currently-running."

A card present in both planes: river wins for live fields (cpu, active, ask),
query plane wins for rollups.

## Scope summary

| # | Item | Type |
|---|------|------|
| 2 | `/api/sessions`: add `q`, `sort`, `order` | extend |
| 3 | `GET /api/facets` (self-excluding) | new endpoint |
| 4 | `GET /api/stats/timeseries` (cost/token rollup) | new endpoint |
| 7 | Work-item ("Quest") pipeline + `GET /api/sessions/:key/quests`, `GET /api/quests` | new table + reporter parse + endpoints |

**Confirmed non-goals (YAGNI):** full-transcript/FTS search; activity-timeline
aggregation; live-counts endpoint (client-side from river); `dateField` toggle
(started_at only); server-side merge layer; any frontend work this phase.

No schema migrations for sections 2-4. Section 7 adds one additive table.

---

## Section 2 — `/api/sessions` extensions (search, sort, leaderboards)

Add three query params; response envelope unchanged (`{ sessions, total }`).

- **`q` (search)** — case-insensitive `LIKE %term%` OR'd across `display_name`,
  `subject`, `summary`, `cwd`, `handle`, `provider`, `model`. Multi-word: split
  on whitespace, **AND** the terms (each term must match some field).
  Parameterized — no injection. This is the unified search; running rows are
  included because they live in the table.
- **`sort`** — whitelist enum mapped to columns; unknown → **400**:
  - `lastSeen` → `last_seen_at` (default)
  - `started` → `started_at`
  - `cost` → `cost_usd`
  - `tokens` → `(tokens_in+tokens_out+tokens_cache_read+tokens_cache_write)`
  - `context` → `peak_context_tokens`
- **`order`** — `asc` | `desc` (default `desc`), with `NULLS LAST`.

**Leaderboards** are just this endpoint: `sort=cost&order=desc&limit=10&since=…`.
No separate endpoint. `total` reflects filter+search and ignores limit/offset.

Decisions locked:
- `q` matches **metadata only** (not transcript text).
- `since`/`until` filter on `started_at` (existing behavior). No `dateField`
  toggle.

---

## Section 3 — `GET /api/facets` (self-excluding)

Populates filter chips/dropdowns with what exists + counts so the UI never
scans or guesses.

**Request:** same filter params as `/api/sessions`
(`state, provider, category, cwd, since, until, minTokens, q`).

**Response:**

```jsonc
{
  "providers":  [{ "value": "claude", "count": 42 }],
  "categories": [{ "value": "code",   "count": 30 }],
  "hosts":      [{ "value": "mbp", "count": 12, "label": "My-MBP" }],
  "states":     [{ "value": "running", "count": 5 }]
}
```

**Counting mode: self-excluding (faceted-search standard).** When computing a
dimension's list, apply all active filters **except that dimension's own**. E.g.
the `providers` facet ignores an active `provider=` filter so the dropdown still
shows other providers ("switch to codex → 8 results"). Implemented as four
WHERE clauses, each dropping its own dimension. `GROUP BY <col> ORDER BY count
DESC`.

---

## Section 4 — `GET /api/stats/timeseries` (cost/token over time)

Samples are **cumulative** snapshots per session (`store.ts` writes
`session.tokensIn` etc; condensation keeps the LAST value). So spend-per-bucket
is a **per-session delta across bucket boundaries**, summed — not a naive sum.

**Request:** `since`, `until`, `bucket` (`hour`|`day`, default `day`),
`groupBy` (`none`|`category`|`provider`, default `none`),
`metric` (`cost`|`tokens`, default `cost`), optional scope filters
(`provider`, `category`, `host`). Unknown enum → 400.

**Query — per-session delta via window function:**

```sql
WITH d AS (
  SELECT s.session_key, s.at,
    s.cost_usd - LAG(s.cost_usd) OVER (PARTITION BY s.session_key ORDER BY s.at) AS dcost,
    -- same LAG for token columns
    ...
  FROM samples s
  WHERE s.at BETWEEN :since AND :until
)
SELECT bucket(at) AS t, SUM(MAX(dcost, 0)) AS value
FROM d JOIN sessions USING(session_key)   -- join only when groupBy needs it
GROUP BY t [, group_col]
ORDER BY t;
```

- `MAX(dcost, 0)` clamps negatives (restart / counter reset → no negative spend).
- First in-window sample of a session has `NULL` delta → contributes 0.
  **Consequence:** spend before the first in-window sample is invisible.
  Acceptable for a rate chart; documented.
- `bucket(at)` = integer-divide epoch to hour/day boundary (SQL or JS post-pass).

**Cross-resolution read (required):** raw samples retain only ~15 days, then
condense to hour/day. The query reads **across resolutions** — prefer `raw`
where present, fall back to `hour`, then `day` — so long windows still chart
(coarser past the raw window) instead of going blank.

**Response:**

```jsonc
// groupBy=none
{ "bucket": "day", "metric": "cost",
  "series": [{ "t": 1718668800000, "value": 12.43 }] }

// groupBy=category|provider — one series per group, zero-filled to same buckets
{ "bucket": "day", "metric": "cost",
  "series": [{ "key": "code", "points": [{ "t": 1718668800000, "value": 4.2 }] }] }
```

Metrics: `cost` and `tokens` only (no active-count-over-time this phase).

---

## Section 7 — Work-item ("Quest") pipeline

Quests = the main kanban-style work units a session is doing (an agent can have
several). Sourced **passively** from data agents already produce.

**Source by provider:**

- **Claude + OpenClaw** (openclaw reuses Claude's transcript parser): the
  provider already parses the transcript JSONL in one pass. Extract the **latest
  `TodoWrite` `input.todos`** → real kanban items with native
  `status ∈ pending|in_progress|completed`. Nearly free (no new file I/O).
- **Codex, OpenCode, pi, Hermes:** no structured task list — zero work-items.
  The UI falls back to `subject` as a single implicit quest. No backend fallback.

**Naming:** entity `WorkItem` (UI label "Quest"); table `work_items`. Distinct
from A2A `AgentTask` / `task.routed` events.

**Type:**

```ts
interface WorkItem {
  itemKey: string;   // stable per-session id = content hash (TodoWrite has no native id)
  subject: string;   // todo content
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  position?: number;
}
```

**Flow (rides the existing pipeline):**

1. `claude.ts` `enrich()` extracts last `TodoWrite.input.todos` → `WorkItem[]`,
   wrapped in try/catch (enrich-never-throws contract). `itemKey` = hash of
   content (TodoWrite rewrites the whole list each call).
2. Extend `Enrichment` + `Session` with `workItems?: WorkItem[]`. Flows through
   `collect.ts` → `HostReport` → `/ws/live` (live cards show quests, no extra
   fetch) and → `store.record()`.
3. New table:

   ```sql
   CREATE TABLE work_items (
     session_key TEXT NOT NULL,
     item_key    TEXT NOT NULL,
     subject     TEXT NOT NULL,
     status      TEXT NOT NULL,
     active_form TEXT,
     position    INTEGER,
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL,
     PRIMARY KEY (session_key, item_key)
   );
   -- indexes: (status), (session_key)
   ```

   `store.record()` upserts seen items (status + updated_at; position).
   Items **absent** from a later snapshot **retain their last status** — kanban
   history preserved, never deleted.

**Read endpoints (new):**

- `GET /api/sessions/:key/quests` → `WorkItem[]` (drill-down).
- `GET /api/quests?state=&provider=&category=&limit=` → cross-session quest
  board, joined to `sessions` for character context.

---

## Touch points

- `packages/shared/src/types.ts` — `WorkItem`; `workItems?` on `Session` +
  `Enrichment`; `SessionSort`, `Facets`, `TimeseriesResponse`, `QuestQuery`
  request/response types (typed contract for the new web).
- `packages/reporter/src/providers/claude.ts` — extract latest `TodoWrite`
  todos. `providers/types.ts`/`collect.ts` — pass `workItems` through.
- `packages/server/src/store.ts` — extend `SessionFilter` (`q`, `sort`,
  `order`); extend `listSessions`/`countSessions`; new `facets()`,
  `timeseries()`; `work_items` table + upsert in `record()`; `listQuests()`,
  `getQuests(sessionKey)`. All pure SQL → unit-testable on `:memory:`.
- `packages/server/src/index.ts` — parse/validate new query params (whitelist
  `sort`/`order`/`bucket`/`groupBy`, reject unknown → 400); wire `/api/facets`,
  `/api/stats/timeseries`, `/api/quests`, `/api/sessions/:key/quests`. All
  `store.*` calls try/catch-guarded (best-effort edge contract).
- **No** `hub.ts` changes (except `workItems` riding on `Session`, which is just
  data passthrough). **No** migration tooling beyond `CREATE TABLE IF NOT
  EXISTS`. No reporter changes outside the claude provider.

## Testing (pure-function-first, repo convention)

- `store.test.ts`: `q` AND-of-terms across fields; sort/order + NULLS LAST;
  pagination `total` vs `limit`; self-excluding facet counts (pick provider →
  providers facet still lists others); timeseries delta clamps negatives,
  first-sample → 0, cross-resolution fallback (raw → hour → day); work_items
  upsert keeps final status when an item drops out; status-transition.
- `index.ts` param validation: bad `sort`/`bucket`/`groupBy` → 400; `q`
  injection attempt stays parameterized.
- `claude` provider: parse latest `TodoWrite` from a fixture transcript;
  content-hash `itemKey` stability across list rewrites.

## RPG theming note (frontend, future)

The retro-RPG theme (sessions as characters, providers as classes, categories as
roles, context/cpu/mem as health, cost as gold, tokens as XP, tools as
inventory, work-items as quests, history as hall of fame, leaderboards via
`sort`) is **almost entirely a presentation layer**. With Section 7 done, every
input it needs already exists on `Session`/`PersistedSession`. Conceptual
inspiration only: `~/Development/me/my-agent-rpg` (its concrete UI design is not
a model to copy). Cards now, possible 3D characters later — out of scope here.
