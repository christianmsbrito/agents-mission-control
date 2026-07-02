# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Live dashboard of every **currently-running** AI agent session (Claude Code, Codex, OpenCode, pi, Hermes, OpenClaw) across all your machines. A session is "open" only while its process is alive — it vanishes from the board when the process exits. Read `README.md` for the user-facing operational details (deploy, env table, provider support matrix); this file is the architecture orientation.

## Runtime & commands

Everything runs on **Bun** (no Node, no bundler config beyond `Bun.build`). TypeScript executes directly via `.ts` imports — note `allowImportingTsExtensions`, so imports carry explicit `.ts`/`.tsx` extensions.

```bash
bun install
bun test                          # all tests (files are *.test.ts colocated with source)
bun test packages/reporter/src/reporter.test.ts   # single file
bun test -t "longest-prefix"      # single test by name
bun run dev                       # server + a local reporter together (scripts/dev.ts)
bun run build:web                 # required before the server can serve the UI
bun run build:reporter            # compile single binary -> dist/mc-reporter
```

There is no lint/typecheck script; `tsc` is configured `noEmit` for editor/type checks only (`bunx tsc`).

## Architecture: a one-way data river

```
reporter (per machine) --HostReport every ~3s--> server (hub) --state/patch/offline--> web (browser)
```

Three processes, four packages. Data flows one direction; nothing flows back to reporters. The **live** state lives **only in memory** in the server — a restart loses the live board, which is fine because reporters re-report within a tick. Alongside it runs a durable **persistence sidecar** (SQLite, `store.ts`) that captures history; it never feeds back into the live river (see below).

- **`packages/shared`** (`@mc/shared`) — the contract. `types.ts` defines `Session`, `HostReport`, and the two wire protocols (`ReporterMsg` reporter→server, `LiveMsg` server→web). `cost.ts` prices tokens by **longest-prefix** model match. `category.ts` resolves a session's role with fixed precedence: `byCwd` regex > `byProvider` > provider default > fallback. Changing any of these ripples through all packages — it's the schema.

- **`packages/reporter`** — scans `ps` every `MC_INTERVAL_MS`, matches processes to providers, enriches, and pushes. Flow: `procscan.ts` (parse `ps`, pure/testable) → `collect.ts` (orchestrates per-process) → `providers/*` (per-agent logic). Compiles to a standalone binary for drop-on-host deployment.

- **`packages/server`** — `index.ts` is the thin `Bun.serve` transport (two WS endpoints: `/ws/report` token-authed in, `/ws/live` out; also serves the built web bundle). `hub.ts` is the **transport-agnostic** in-memory state machine — all the logic (ingest/broadcast/stale-sweep) lives here so it unit-tests without real sockets. Keep that separation. The river is mostly one-way, but a narrow command channel runs server→reporter: `focus`, `kill`, `prompt`, and now `spawn` (a 4th verb). `spawn` is gated by the `templates` registry — only a pre-defined template executes, the provider CLI is resolved from the stored template (never free-form from the client) — and acks back a `spawned` message.

- **`packages/web`** — React 19 grid. `useLive.ts` holds the WS connection + reduces `state`/`patch`/`offline` messages into host state; `App.tsx` renders grouped by category. Built with `Bun.build` from `src/index.html`.

## The provider plugin model (most common extension point)

A `ProviderPlugin` (`providers/types.ts`) has `id`, `defaultCategory`, `matchProcess(p)`, and an optional `enrich()`. Register it in `providers/index.ts`. Key design rules baked in:

- **`enrich()` must never throw to the caller** — `collect.ts` wraps it in try/catch and falls back to base stats, so one unparseable session file can't kill the whole host report. Match that contract.
- Enrichment maps a process to its session file by **`cwd`**, picking the *newest* transcript for that project. Consequence: multiple sessions sharing a cwd can report identical totals. Daemons without cwd scoping (hermes/openclaw) use the most-recent session globally.
- **Subagent cost**: Claude Code logs each Task/Agent subagent to its own transcript under `<projectDir>/<sessionId>/subagents/agent-*.jsonl` — absent from the main `<sessionId>.jsonl`. `claude.ts`'s `enrich()` folds those tokens into the session's four counters (`foldSubagents` → `sumSubagentUsage`/`addSubagentUsage`, both pure/tested) so subagent-driven sessions (thin orchestrator, heavy delegates) don't under-report cost by ~5x. Only the token counters are summed — `contextTokens` stays the main session's live-window snapshot. A per-session mtime cache avoids re-parsing unchanged files every tick. The backfill adapter mirrors this (main-only sample timeline, folded rollup).
- Returning `summaryInput` (recent role-tagged conversation text) from `enrich()` is what opts a provider into **LLM recaps**. It is stripped before storage in `collect.ts` and fed to the background summarizer; it never lands on `Session`.
- `active` vs `attention` are distinct signals: `active` = processing now; `attention` = blocked waiting on the user (drives the amber "needs input" flag). Only providers that expose authoritative state set them (e.g. claude reads `status` from `~/.claude/sessions/<pid>.json`).

## Persistence (SQLite) is a best-effort sidecar at the edge

`packages/server/src/store.ts` is a `Store` class on `bun:sqlite` that captures history. It lives at the `index.ts` I/O **edge** — `hub.ts` stays pure/in-memory, same separation rule as the transport. Every store call from `index.ts` is wrapped in try/catch: **a store failure must never break live reporting or routing** (mirrors the `publishEvent` contract).

Five tables:
- **`sessions`** — the registry, one row per session kept forever. Keyed by a durable `session_key` (provider-native id else synthetic `${hostId}:${pid}:${startedAt}`). Tracks a lifecycle `state` (`running`/`closed`/`orphaned`), `resume_id`, `handle`, `display_name`, a sticky `template_id` lineage (the template that spawned it, set-once via `COALESCE`), and rollups (cost, tokens, peak context, merged tools).
- **`samples`** — per-session time-series with a `resolution` (`raw`/`hour`/`day`), gated to one raw row per `sampleIntervalMs` and downsampled as it ages.
- **`events`** — discrete events. Two emission paths: the **store diff** writes history-only rows (`session.started/closed/state/tool/errored`, `task.routed/replied`); the **`index.ts` edge** publishes a richer set **live** on `/ws/events` + `events.jsonl` (plus sqlite): `session.killed/prompted/spawned`, `session.started/errored/attention` (carry `templateId` when the session is a troop), `troop.closed` (final rollup), `troop.idle`, `quest.completed`, `budget.exceeded`, `host.online/offline`, `template.created/updated/deleted/leveled_up`. The live lifecycle events come from `record()` returning a structured **`RecordDiff`** (`started/closed/errored/attention/questsCompleted`); `emitLifecycle()` turns that diff (plus the tick's live sessions for the threshold checks) into published events. Tier-3 checks are config-gated: `budget.exceeded` needs `AppConfig.budgetUsd`, `troop.idle` needs `idleMinutes` (env `MC_BUDGET_USD`/`MC_IDLE_MINUTES`). To promote a new lifecycle signal to the live stream, add it to `RecordDiff` + `emitLifecycle` — detection already exists.
- **`templates`** — the templates registry: id PK, provider/args/prompt/cwd/rpg, soft-archived (`archived_at`). XP is derived on read (troops/cost/tokens/level) by rolling up `sessions.template_id` — no stored XP column.
- **`work_items`** — kanban "quests" per session, keyed by `(session_key, item_key)` where `item_key` is a content hash. Sourced passively from Claude/OpenClaw `TodoWrite` lists (rides `Session.workItems` through the live pipeline), upserted in `record()`; items dropped from a later snapshot retain their last status. Read via `getQuests(key)` / `listQuests(filter)`.

Capture flow at the edge: `store.record(report, now)` (after `hub.ingest`) does registry upsert + snapshot-diff→events + the sample gate; `store.onHostOffline(hostId, now)` orphans a host's running rows on socket-close or stale-sweep; `store.maybeCompact(now)` runs on the 2s timer and does tiered downsampling (raw→hour→day age ladder + a `maxBytes` size ceiling). Lifecycle/A2A events are **dual-written**: kept on the existing `~/.mission-control/events.jsonl` *and* inserted into the sqlite `events` table (the jsonl was intentionally kept this round — a future follow-up may consolidate).

Read-only HTTP endpoints (public, same trust model as `/ws/live`): `GET /api/sessions` (filters + unified `q` search + `sort`/`order`), `/api/sessions/:key`, `/api/sessions/:key/samples`, `/api/sessions/:key/quests`, `/api/events`, `/api/facets` (self-excluding filter-chip counts), `/api/quests` (cross-session board), `/api/stats/timeseries` (bucketed cost/token rollup via per-session delta over cumulative samples). DB path from `MC_DB` (`:memory:` in tests) else `~/.mission-control/mc.db`; retention env vars are listed in `README.md` and seeded in `config.ts`.

**Backfill** (`scripts/backfill.ts`, `bun run backfill`) is a standalone CLI — *not* part of the live server — that imports **historical** on-disk sessions into the same `Store`. `backfill/index.ts`'s `runBackfill` walks a `REGISTRY` of one adapter per provider (`backfill/adapters/*`), each reusing the reporter's `providers/*` parsers and writing closed rows + hour-only samples through `importSession`. Three nested guards (provider/session/field) make every adapter degrade independently — one bad provider/session/field is skipped, never fatal — and `store.has(key)` skip-if-exists means re-runs only add new sessions and live rows always win. An optional key-gated Haiku phase (`backfill/enrich.ts`, `--enrich-only`/`--no-enrich`) fills summaries. Resume ids carry over where the provider exposes one (codex `codex resume <uuid>`, hermes `hermes --resume <id>` for cli-source; opencode has none).

## Summaries (Haiku) are best-effort and async

When `ANTHROPIC_API_KEY` is set, `summarizer.ts` generates one-line recaps with Claude Haiku **in the background**, cached per session by content hash and rate-limited per `MC_SUMMARY_INTERVAL_MS`. A recap shows up a tick *after* it's ready and overrides the heuristic summary. Without the key (or `MC_SUMMARIES=0`) everything else works unchanged — never make core reporting depend on summaries.

## Conventions

- Cost: prefer a provider-reported `costUsd` (pi/hermes track their own); otherwise `collect.ts` estimates from the price table. Cache-read tokens bill at `CACHE_READ_FACTOR` (10%) of input.
- Tests are pure-function-first: parsing (`parsePs`, `parseEtime`), cost/category math, and the `Hub` are all tested without I/O. New logic should follow — keep side-effects (fs, sockets, `ps`) at the edges so the core stays testable.
- The Codex hook (`hooks/`, `scripts/install-codex-hook.ts`) is one provider adapter. It writes live state for the reporter, delegates `UserPromptSubmit` payloads to the generic Mission Control prompt interceptor, and delegates `Stop` payloads to route target answers back to source agents.
- The Claude Code hook installer (`scripts/install-claude-hook.ts`) registers the same generic prompt adapter for `UserPromptSubmit` and `Stop` in `~/.claude/settings.json`. Keep alias routing provider-agnostic in the server; add thin provider adapters only when an agent exposes prompt/completion hook or message surfaces.
- Persistence is **best-effort and edge-wired**: all `store.*` calls live in `index.ts` (never in `hub.ts`) and are try/catch-guarded so a DB error degrades to no-history, not no-live-board. Events are dual-written to both `events.jsonl` and the sqlite `events` table.
