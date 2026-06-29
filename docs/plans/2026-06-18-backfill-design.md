# Backfill Design — historical session import

**Date:** 2026-06-18
**Status:** Design (pre-implementation)
**Companion:** builds on the merged persistence layer (`docs/plans/2026-06-18-persistence-layer-design.md`).

## Goal

The persistence layer only captures sessions observed *after* it was deployed. This backfill imports **historical** agent sessions already sitting on disk into `~/.mission-control/mc.db`, so the History view, registry, resume, and metrics cover the past too. Graceful degradation is the through-line: every provider, session, and field degrades to skip/null rather than failing the run.

## On-disk sources (verified on this machine)

| Source | Location | Sessions here | Registry | Samples | Resume id |
|---|---|---|---|---|---|
| claude | `~/.claude/projects/<enc-cwd>/<id>.jsonl` | ~346 | ~95% | ✅ real (per-msg ts) | ✅ sessionId |
| codex | `~/.codex/sessions/.../rollout-*.jsonl` | 124 | ~70% | ✅ token_count events | ✅ rollout UUID (`session_meta.id`) → `codex resume <id>` |
| hermes | `~/.hermes/state.db` (SQLite) | 5,989 (5,938 cron) | tokens/model/title | ⚠️ session-level only | ✅ `sessions.id` → `hermes --resume <id>` (cli source only) |
| openclaw | `~/.openclaw/agents/*/sessions/*.jsonl` | 1 | ~82% | ✅ per-msg | ✅ UUID |
| opencode | `~/.local/share/opencode/storage/{session,message,part}` | 1 | ~47% skeleton | ❌ | ❌ |
| events.jsonl | `~/.mission-control/events.jsonl` | 415 events | — | — | **not a backfill source** (transient `hostId:pid` keys can't bridge to durable keys; keep as audit log) |

**Resume corrections** (the initial exploration was wrong on both): codex exposes the rollout UUID via `session_meta.id` (== filename UUID), consumed by `codex resume <id>`; the live parser already sets `providerSessionId`. Hermes is resumable via `hermes --resume <id>` (id = `state.db sessions.id`), but it runs in Docker behind a `hermes` shell-function wrapper and is cwd-agnostic — so its resume command has **no `cd` prefix** and assumes the wrapper exists on the target machine; only `source=cli` rows are meaningfully resumable. Net: every provider except **opencode** has a working resume path.

## Decisions (brainstorm outcomes)

| Decision | Choice |
|---|---|
| Invocation | One-shot CLI: `bun run backfill` (`scripts/backfill.ts`). No live-server / hot-path changes. |
| Degradation | Nested isolation: provider-guard → session-guard → field-guard (null-fill). End-of-run report. |
| Provider scope | All five, as isolated adapters (weak ones degrade, not fail). |
| Hermes cron | Skip `source=cron` by default; `--include-hermes-cron` opt-in. Map `source`→category. |
| Samples | Synthesize `resolution='hour'` directly via `condenseSamples()` where per-turn timestamps exist (claude/codex/openclaw); else none (empty sparkline, totals from rollups). Never write `raw` for old data. |
| Idempotency | Session-level skip-if-exists (`session_key` already in registry → skip all three tables). Live data always wins; events emit safely under the guard. |
| host fields | Backfill runs on the machine that owns the data → `hostId`/`hostLabel` = `os.hostname()`. |
| state / ended_at | All backfilled rows `state='closed'`, `ended_at` = last activity ts. |
| Enrichment persistence | Add `summary`/`attention`/`ask`/`suggestion` to the registry; **both** live `record()` and backfill populate them. |
| Enrichment for backfill | Batched Haiku: sync multi-session prompt, id-keyed list back. Separate phase, key-gated, batch-isolated, re-runnable. |

## Core principles preserved

- **No live-path changes beyond additive ones.** Backfill is a standalone CLI reusing `Store` + the provider parsers. The only live edits: 4 new registry columns and `record()` writing them.
- **Reuse, don't reimplement.** Provider transcript parsers live in `packages/reporter/src/providers/*` and are imported by the adapters. `condenseSamples`/`hourBucket`/`estimateCost`/`resolveCategory` are reused as-is.
- **Persistence/enrichment never block core.** Same contract as the live layer: no API key ⇒ everything else still works.

---

## Section 1 — Shape & architecture

```
scripts/backfill.ts                 — CLI: flags, orchestration, report
packages/server/src/backfill/
  index.ts                          — adapter registry + runBackfill(store, opts)
  types.ts                          — BackfillAdapter contract
  enrich.ts                         — batched Haiku enrichment phase
  adapters/_common.ts                 — buildClosedSession / trimTail helpers
  adapters/{claude,codex,hermes,openclaw,opencode}.ts
```

```
runBackfill(store, opts):
  # PHASE 1 — core import (no API)
  for adapter in REGISTRY where adapter.available():     # provider guard (try/catch)
    for raw in adapter.discover(opts):                   # session guard (try/catch)
      key = adapter.sessionKey(raw)
      if store.has(key): report.skipped++; continue      # idempotency / live-wins
      { session, samples, events } = adapter.toImport(raw)
      session.category = resolveCategory(provider, cwd, …)   # except hermes (source→category)
      session.costUsd ??= estimateCost(model, tokens…)
      store.importSession(session, samples, events)
  # PHASE 2 — enrichment (key-gated, re-runnable)
  if hasApiKey && !opts.noEnrich: enrichMissing(store, adapters, opts)
  return report
```

---

## Section 2 — Adapter contract + degradation

```ts
interface BackfillAdapter {
  id: string;
  available(): boolean;                                 // data dir/db exists?
  discover(opts): Iterable<RawSession> | AsyncIterable<RawSession>;
  sessionKey(raw): string;                              // cheap, pre-parse
  toImport(raw): { session: PersistedSession; samples?: SessionSample[]; events?: PersistedEvent[] };
  enrichInput?(raw): string;                            // role-tagged tail for Haiku (optional)
}
```

**Three concentric guards** (orchestrator-enforced):
1. **Provider** — `available()` false ⇒ skip silent; any throw ⇒ log + record + continue to next adapter.
2. **Session** — `sessionKey`/`toImport` throw ⇒ `report.skipped++` with reason, continue to next session.
3. **Field** — `undefined` ⇒ SQL `NULL`. Only `session_key`/`provider`/`started_at` are required.

**Report:** per-provider `{ imported, skipped (reasons), failed }` + enrichment tally. Printed and returned (for tests).

---

## Section 3 — Per-provider mapping & sample synthesis

Common: `provider` literal, `hostId`/`hostLabel`=`os.hostname()`, `state='closed'`, `ended_at`=last ts, `category` via resolver.

| Field | claude | codex | hermes | openclaw | opencode |
|---|---|---|---|---|---|
| session_key | sessionId | rollout UUID | `sessions.id` | UUID | session.id |
| resume_id | ✅ | ✅ UUID | ✅ (cli only) | ✅ | ❌ |
| cwd | ✅ | ✅ | ❌ | ✅ | ✅ |
| model | ✅ | ⚠️ infer | ✅ | ✅ | ✅ |
| tokens (in/out/cacheR/cacheW) | ✅ | ✅ (no cacheW) | ✅ | ✅ | ❌ |
| cost_usd | est. | est. | ⚠️ stored=0 → est. | ✅ native | ❌ |
| peak_context_tokens | ✅ | ✅ | ❌ | ⚠️ approx | ❌ |
| tools_used | ✅ | ✅ | ✅ | ✅ | ❌ |
| subject | ✅ | ✅ | ✅ title | ✅ | ⚠️ |
| started/ended | ✅ | ✅ | ✅ | ✅ | ✅ |

**Cost:** where tokens exist and cost is absent/zero ⇒ `estimateCost(model, …)` (claude/codex/hermes); openclaw native; opencode null.

**Samples** (claude/codex/openclaw only): walk usage-bearing entries `(ts, cumulative tokens, contextTokens, contextWindow?)`, group by `hourBucket(ts)`, run `condenseSamples()` → one `resolution='hour'` row per (key,hour); cumulative=last, gauges=avg, `active`=fraction of active hours. `cpu`/`mem_mb` null. hermes/opencode ⇒ no samples.

**Events** (under skip-if-exists, one-time): `session.started` (first ts), `session.closed` (ended ts), `session.tool` per distinct tool first-seen, `session.errored` where flagged (claude `isApiErrorMessage`). No `killed`/`prompted` (server-only).

---

## Section 4 — Store.importSession, CLI, testing

**Schema migration (additive):** `summary TEXT`, `attention INTEGER`, `ask TEXT`, `suggestion TEXT` on `sessions`. `CREATE TABLE IF NOT EXISTS` for new DBs + guarded `ALTER TABLE ADD COLUMN` (catch "duplicate column") for existing ones.

**`Store.importSession(session, samples?, events?): "imported" | "skipped"`** — one transaction: skip-if-exists check → registry insert (incl. enrichment columns) → samples (`INSERT OR IGNORE`) → events. Live `record()` extended to write the 4 enrichment columns in its existing upsert (from the `Session` it already holds — no new API calls).

**CLI flags:**
```
bun run backfill
  --providers claude,codex      # subset (default all)
  --include-hermes-cron         # include the 5.9k cron rows
  --no-enrich                   # skip Haiku phase
  --enrich-only                 # phase 2 only, on rows missing summary
  --batch-size 15               # sessions per Haiku call
  --dry-run                     # parse + report, write nothing
```

**Tests (pure-first):** adapter parsers against fixtures → assert `{session,samples,events}`; `importSession` on `:memory:` (skip-if-exists, null-fill, live-row-not-clobbered); batched enricher with a mocked Anthropic client (id-keyed mapping + misaligned/short-list degradation); degradation paths (adapter-throws / session-throws / no-key) all yield a valid report, never an exception.

---

## Section 5 — Batched enrichment phase

Module `packages/server/src/backfill/enrich.ts`. Runs after core import, gated on `ANTHROPIC_API_KEY` and `!--no-enrich`.

**Selection:** `SELECT … FROM sessions WHERE summary IS NULL` (first run = just-imported rows; `--enrich-only`/re-run = only un-enriched). Each row's conversation tail comes from `adapter.enrichInput(raw)` (role-tagged, truncated like the live `summaryInput`).

**Loop:**
```
for chunk of N rows (default 15, bounded by token budget):
  ONE Haiku call: numbered list of { id, subject?, tail }
  structured output: array of { id, subject, summary, awaitingUser, ask, suggestion }
  map back BY id (batch-local), not position
  UPDATE sessions SET summary, attention=awaitingUser?1:0, ask, suggestion,
                     subject = COALESCE(model.subject, heuristic subject)
  unmapped/missing ids → leave null (degrade), record in report
```

**Prompt contract:** reuse the live summarizer field semantics, multi-item variant. `awaitingUser` = "did the session's *final* turn leave the user something to answer" (resume-relevant for closed sessions). Per-session tail capped (~last 12 role-tagged msgs, char-truncated) so N fit one context window.

**Degradation:** no key ⇒ phase skipped (heuristic subject already set at import; rest null). Batch throws ⇒ one retry, then that chunk stays null, next chunk continues. Short/misaligned array ⇒ only mapped ids updated; id-keying prevents cross-assignment. Malformed item ⇒ skip item, keep batch.

**Report:** `enriched: N, degraded: M (reasons), skipped-phase: bool`. ~600 ÷ 15 ≈ 40 Haiku calls — logged, not silent spend.

---

## Implementation order (suggested)

1. Schema: 4 enrichment columns + migration; extend live `record()` to write them; `Store.importSession` + `Store.has`. Tests.
2. Adapter contract + registry + orchestrator with the three guards + report. Tests with a fake adapter.
3. Adapters one per provider (reuse `providers/*` parsers), each with fixtures. claude → codex → hermes → openclaw → opencode.
4. Sample synthesis (hour-resolution via `condenseSamples`) in the adapters that support it.
5. `scripts/backfill.ts` CLI + flags + report printing.
6. Enrichment phase (`enrich.ts`) + batched analyzer + mocked-client tests.
7. `resumeCommand` additions: hermes template (`hermes --resume <id>`, no cd); verify codex (`codex resume <id>`) and opencode flags.
8. Docs: README (`bun run backfill` + flags), architecture.md (backfill component), CLAUDE.md note.

## Risks / open verifications

- **opencode resume flag** still unverified (`--session`?) — may stay disabled-button.
- **hermes resume** assumes the `hermes` shell-function wrapper on the target machine; document the raw `docker exec …` fallback.
- **Batched Haiku output drift** — model may return fewer/extra items; id-keying + per-item validation contain it, but monitor the degraded count.
- **Token budget per batch** — long tails could blow the context window; truncate per-session and cap N defensively.
- **codex model name** isn't in rollouts (only `model_provider: openai`) — infer (gpt-5) or leave model coarse.
