# Sub-sessions & activity-time — design

Date: 2026-07-02

## Goals

Three persistent additions to the board:

1. **Activity time** — how much of a session's *lifespan* it was actually working
   (CPU-based), vs. sitting idle.
2. **Per sub-session breakdown** — an expandable, click-to-drill list inside each
   agent card showing each subagent's usage / context / cost / tools.
3. **Main vs. total usage** — headline number stays the *true total* (main +
   subagents, per the cost fix), with the split surfaced (main $X / subagents $Y).

## Findings that shape the design

- **Subagents are in-process.** Claude runs Task/Agent subagents as a nested loop
  inside the *same* `claude` OS process (they share the parent `sessionId`, carry
  no pid). The reporter only ever sees one process, so its CPU sample already
  includes subagent compute — activity time counts subagent work for free.
- **The `active` flag is weak.** Only ~2% of raw samples carry it; Claude writes
  `busy`/`shell` status briefly and the 60s reporter cadence usually misses it.
- **CPU is the better activity signal.** `active`-rate rises 0.6% → 14% → 67% across
  cpu buckets 0 → [5,10) → [10,25). The natural split is at **exactly 0** (89% of
  samples; nothing lands in (0,1)). ~28% of flag-active samples show cpu=0 (blocked
  on an API response), so we OR the flag back in to rescue those.

## Activity metric

**A raw sample is "active" when `cpu > threshold` OR `active flag = 1`.**
`threshold` is configurable via `MC_ACTIVE_CPU_PCT` (default **1** — i.e. any
measurable CPU, matching the data's clean split at 0). Higher values (5–10) count
only heavy work.

Persisted, downsample-proof: add **`activeMs`** to the session registry row,
accumulated in `store.record()` — each sampled tick adds `min(now − lastActiveTick,
sampleInterval·slack)` to `activeMs` when the current sample is active. Denominator
is the lifespan (`(endedAt ?? lastSeenAt) − startedAt`). `active% = activeMs /
lifespanMs`. Existing sessions are backfilled by replaying their stored `cpu`
samples (the data is already there).

> Point-in-time 60s sampling *undercounts* bursty CPU, so activity time is a lower
> bound. Documented, acceptable — cumulative CPU-time isn't collected today.

Card shows: `Lifespan 4h12m · Active 39% · Idle 61%` + a thin bar. Detail sheet
adds the raw ms.

## Sub-session data model

The reporter's `foldSubagents` (which sums subagent tokens into the total) is
extended to also emit a **per-subagent breakdown** instead of only a sum.

- **Shared contract** — new `SubSession` type: `{ agentId, tokensIn, tokensOut,
  tokensCacheRead, tokensCacheWrite, costUsd?, model?, peakContextTokens?,
  toolsUsed?, firstAt?, lastAt? }`. Carried on the live `Session.subSessions?:
  SubSession[]` (rides the river like `workItems`). `Session.tokensIn/…/costUsd`
  stay the **total** (headline true cost). Main-only = total − Σ subSessions.
- **Persistence** — new `sub_sessions` table keyed by `(session_key, agent_id)`,
  upserted in `record()` (mirrors `work_items`). Kept separate from `sessions` to
  avoid double-counting the parent's total and polluting the live board /
  facets / timeseries.
- **API** — `GET /api/sessions/:key/subagents` → `SubSession[]`; the live card
  reads them straight off `Session.subSessions`.

Wire cost: ~62 compact rows per subagent-heavy session per tick. Numeric-only +
a capped tool list; a few KB — acceptable.

No per-subagent *time series* (subagents aren't sampled live); detail is the
static breakdown (tokens / peak context / cost / tools / duration from the
transcript). That satisfies "usage / limits / costs / details".

## UI

Inline expandable list with a second click-to-expand level (your note):

```
┌─ mc:a54  rubik  $161 ─────────────────────┐
│ opus · 2.4M ctx · Active 39% of 4h12m      │
│ ▸ 62 subagents · $126 (78%)   main $35     │  ← click row 1: reveal list
└────────────────────────────────────────────┘
   ▾ Explore    $4.2   310k   Grep,Read       │  ← click a row: expand its detail
   ▾ code-rev   $9.1   880k   Read,Bash,Edit  │
       in 840k · out 40k · cache 1.2M
       peak ctx 180k · model opus · 3m12s
   …
```

- Reuse `fmtTokens`/`fmtCost`/`fmtUptime` and the existing inline-expand pattern
  (`TemplateCard`).
- `CharacterSheet` (detail drawer) gains an activity-time attribute + a
  sub-session table (sortable), reusing its existing sections.
- `HallOfRecords` historical rows show `active%` and subagent count.

## Build phases

- **Phase 0 (contract, sequential):** shared `types.ts` — `SubSession`,
  `Session.subSessions`, `PersistedSession.activeMs`, persisted sub-session shape,
  API response types. Everything else depends on this.
- **Phase 1 (parallel):**
  - *Reporter*: `foldSubagents` → `collectSubagents` returning the breakdown; keep
    the total fold; unit tests.
  - *Server*: `sub_sessions` table + upsert; `activeMs` accumulation + samples
    backfill; `/api/sessions/:key/subagents`; store tests.
  - *Web*: expandable subagent list + per-row detail; activity gauge; main-vs-total;
    CharacterSheet + HallOfRecords additions.
- **Phase 2 (sequential):** integration wiring, `bun test`, `bun run build:web`,
  CLAUDE.md.

## Non-goals (YAGNI)

- No per-subagent live process tracking or time-series sparkline.
- No subagent rows in the `sessions` table / live board.
- No change to the cost/price math (already correct).
