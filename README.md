# Agents Mission Control

Live web dashboard of every **currently-open AI agent session** — Claude Code,
Codex, OpenCode, pi, Hermes, and future agents — across **all your machines**.
"Open" means a live agent process is running right now; sessions disappear from
the board when the process exits.

![flow](docs/plans/2026-06-15-agents-mission-control-design.md)

## How it works

```
 each machine                         central
┌───────────────┐   WebSocket push   ┌──────────────┐   WebSocket   ┌─────────┐
│ mc-reporter   │ ─────────────────► │  mc-server   │ ────────────► │ browser │
│ scans procs   │   HostReport/3s    │  in-memory   │  state/patch  │  React  │
│ + enriches    │                    │  hub         │  /offline     │ grid    │
└───────────────┘                    └──────────────┘               └─────────┘
```

- **reporter** (`packages/reporter`): every ~3s runs `ps`, matches known agent
  CLIs via a provider registry, resolves each process's `cwd`, and best-effort
  reads that provider's session file for model / tokens / tools / summary. Tags a
  role/category. Pushes a `HostReport` over WebSocket. Compiles to a single binary.
- **server** (`packages/server`): `Bun.serve` hub. `/ws/report` (reporters, token
  auth) in, `/ws/live` (browsers) out. Keeps state in memory, drops a host after
  `MC_STALE_MS` of silence. Also serves the built web app.
- **web** (`packages/web`): React grid grouped by category, live over WebSocket.
- **shared** (`packages/shared`): types, cost table, category resolution.

## Requirements & platform support

- **Runtime: [Bun](https://bun.sh)** on every machine (server *and* each
  reporter). There is no Node fallback; `.ts` runs directly.
- **Reporter OS: macOS or Linux.** Process discovery uses `ps` / `lsof`, so the
  reporter does **not** run on Windows. The dashboard and server run anywhere Bun
  does — a Windows user can still open the web UI served by someone else's hub.
- **Agent CLIs are auto-detected** wherever they write their canonical session
  files (`~/.claude`, `~/.codex`, `~/.local/share/opencode`, `~/.hermes`, …). You
  only see the agents you actually run; no per-agent key or config is needed.

Some features are **macOS-only** and degrade gracefully (no crash, the feature is
just unavailable) elsewhere:

| Feature | macOS | Linux | Windows |
|---------|:-----:|:-----:|:-------:|
| Process board, cost/tokens, history, summaries | ✅ | ✅ | ❌ reporter |
| Deploy a templated agent | ✅ via iTerm2/Terminal tab | ✅ into tmux (no auto-open) | ❌ |
| Click a PID to focus its terminal | ✅ iTerm2 / Apple Terminal | ❌ | ❌ |
| Prompt an agent from a card | ✅ iTerm2 / Apple Terminal | ❌ | ❌ |
| List iTerm tabs | ✅ | ❌ | ❌ |

The macOS-only pieces all live in `packages/reporter/src/focus.ts` and
`iterm.ts`, gated on `process.platform === "darwin"`. **`tmux` is required** on
any host that deploys templated agents (`bun run` spawns into tmux).

## Quick start (single machine)

```bash
bun install
bun run build:web
MC_TOKEN=mysecret bun run dev          # server + web on http://localhost:7777
# in another shell:
MC_TOKEN=mysecret MC_HOST_LABEL=mymac bun run dev:reporter
open http://localhost:7777
```

## Multiple machines

1. Run the server on one always-on host. Recommended: put all machines on a
   [Tailscale](https://tailscale.com) tailnet so reporters can reach it.
2. Build a reporter binary and drop it on each machine:
   ```bash
   bun run build:reporter        # -> dist/mc-reporter
   ```
3. Run it via launchd (`deploy/com.mc.reporter.plist`) or systemd
   (`deploy/mc-reporter.service`). Set per-host env:
   - `MC_SERVER_URL=wss://hub.tailnet:7777/ws/report`
   - `MC_TOKEN=...` (must match the server's `MC_TOKEN`)
   - `MC_HOST_LABEL=macbook`

## Categories ("proficiency")

Each session is tagged with the role you use that agent for. Copy
`mission-control.config.example.ts` → `mission-control.config.ts` and map by
provider and/or cwd regex. Precedence: `byCwd` > `byProvider` > provider default.

## Config

| Env | Where | Default | Meaning |
|-----|-------|---------|---------|
| `MC_TOKEN` | both | `dev-token` | shared auth secret |
| `MC_PORT` | server | `7777` | listen port |
| `MC_STALE_MS` | server | `10000` | drop host after this silence |
| `MC_SERVER_URL` | reporter | `ws://localhost:7777/ws/report` | hub address |
| `MC_HOST_LABEL` | reporter | hostname | friendly host name |
| `MC_INTERVAL_MS` | reporter | `3000` | scan cadence |
| `MC_HOME` | reporter | `$HOME` | base dir for session files (tests) |
| `ANTHROPIC_API_KEY` | reporter | — | enables LLM session recaps (Haiku) |
| `MC_SUMMARIES` | reporter | `1` | `0` to disable LLM recaps |
| `MC_SUMMARY_MODEL` | reporter | `claude-haiku-4-5` | model for recaps |
| `MC_SUMMARY_INTERVAL_MS` | reporter | `60000` | min gap between re-summarizing a session |
| `MC_DB` | server | `~/.mission-control/mc.db` | SQLite history file (`:memory:` in tests) |
| `MC_SAMPLE_INTERVAL_MS` | server | `60000` | min gap between time-series samples per session |
| `MC_RETAIN_RAW_DAYS` | server | `15` | keep raw-resolution samples this long |
| `MC_RETAIN_HOUR_DAYS` | server | `90` | keep hourly-resolution samples this long |
| `MC_RETAIN_EVENT_DAYS` | server | `90` | hard-delete events older than this |
| `MC_RETAIN_MAX_BYTES` | server | `500000000` | DB size ceiling (soft cap); preempts the age ladder |
| `MC_COMPACT_INTERVAL_MS` | server | `3600000` | min gap between compaction runs |
| `MC_RETAIN_ORPHAN_CLOSE_DAYS` | server | `7` | reconcile a still-orphaned session to `closed` after this many days |

`MC_STALE_MS`, `MC_SUMMARIES`, `MC_SUMMARY_MODEL`, and `MC_SUMMARY_INTERVAL_MS`
are now **boot defaults only** — the live Settings page (below) can override them
at runtime without an env change or restart.

## Settings

The dashboard has a Settings panel (gear, top-right) with three tiers of config,
each persisted in a different place:

- **Browser view prefs** → `localStorage["mc.prefs"]`. Pure client-side: theme,
  show/hide cost & tokens, sort, density, and category/provider/host filters.
  Per-browser; never leaves the machine.
- **Server runtime config** → `~/.mission-control/config.json` on the server.
  `staleMs` (host-drop timeout), the category mapping, and the history
  **retention** policy (sample interval + the `MC_RETAIN_*` / `MC_COMPACT_*`
  knobs). Loaded at boot merged *over* the `MC_*` env defaults, editable live
  from the panel, and broadcast to all connected browsers so everyone sees the
  change immediately. Retention edits apply on the next sample/compaction
  without a restart.
- **Reporter summary settings** → pushed from server to reporters over the
  command channel (and re-pushed when a reporter sends `hello`, so reconnecting
  reporters pick up the current value). `enabled` / `model` / `minIntervalMs`.

Caveats and intentional limits:

- **`staleMs` floor**: clamped to a minimum of **2000ms**, both when applied from
  the panel and when loaded from disk.
- **Summaries take effect at different times**: `minIntervalMs` applies **live**
  on reporters; changing `model` or `enabled` only takes effect on the **next
  reporter restart** (the new value is stored and re-pushed on `hello`, but the
  Haiku generator is built once at boot).
- **Auth posture**: `/ws/live` settings writes (`set-settings`) are
  **unauthenticated** this round — same posture as the existing focus/kill/prompt
  writes. Fine for a trusted network (e.g. a Tailscale tailnet); gate `/ws/live`
  behind auth before exposing the dashboard on an untrusted network.

## Adding a provider

Add a `ProviderPlugin` in `packages/reporter/src/providers/` (define
`matchProcess`, `defaultCategory`, optional `enrich`) and register it in
`providers/index.ts`. No `enrich` = it still shows up with base process stats.

To enable **LLM recaps** for the new provider, have `enrich` return
`summaryInput` — the recent conversation text (role-tagged, e.g. `user: …` /
`assistant: …`). The reporter feeds that to Haiku and the recap appears as the
session summary. See `providers/codex.ts` / `providers/opencode.ts` for the
pattern: locate the session file for the process (match by `cwd`), parse recent
turns, return `summaryInput`. Without it, the provider shows base stats only.

## Tests

```bash
bun test
```

## Prompt an agent from the dashboard

Each card has a text input in its footer — type a message, press Enter (or Send),
and it's delivered to that agent. The request relays to the host's reporter, which
types the text + Enter into the agent's terminal session via AppleScript
(`write text`), matched by tty.

- **macOS + iTerm2 / Apple Terminal only** (the tty-addressable terminals).
  Cursor/VS Code integrated terminals can't be injected into.
- Only works for a PID the reporter tracks as an agent.
- A `session.prompted` event is published (same `/ws/events` + `events.jsonl`,
  and also recorded in the SQLite history).
- ⚠️ The text goes to whatever the terminal's foreground program is — normally the
  agent's input. Best used when the session is idle/awaiting input.

## Close a session

Hover a card and click **×** → a confirmation modal → on confirm, the request
relays to that host's reporter, which sends **SIGTERM** to the agent process.
The reporter only kills PIDs it currently tracks as agent sessions (it refuses
anything else), so the dashboard can't be used to kill arbitrary processes.

### Lifecycle events (consumable)

When a session is killed the server publishes a `session.killed` event for
downstream consumers, in two places:

- **Live**: `ws://<server>/ws/events` — connect and receive JSON events.
- **Durable**: appended to `~/.mission-control/events.jsonl` (one JSON per line)
  **and** recorded in the SQLite `events` table (queryable via `GET /api/events`
  and the History view). The jsonl log is kept for now alongside the database;
  the two may be consolidated in a future release.

```json
{"type":"session.killed","at":1781…, "sessionId":"host:1234","hostId":"host","pid":1234,"ok":true,"provider":"claude","cwd":"/repo","subject":"…"}
```

### Lifecycle hooks: troop / template death

To trigger your own process when a deployed agent or a template goes away
(report back to the template, update a vault, …), consume these events on
`/ws/events` (or tail `events.jsonl` / query `GET /api/events`):

- **`troop.closed`** — a session that was spawned from a template ended. Carries
  the lineage and the troop's final rollup so you can attribute/report it:

  ```json
  {"type":"troop.closed","at":1781…,"sessionId":"host:900","hostId":"host","pid":900,
   "ok":true,"templateId":"code-review","provider":"codex","cwd":"/repo",
   "subject":"review the diff","summary":"…","costUsd":0.5,"tokensIn":1000,"tokensOut":200,"durationMs":840000}
  ```

- **`template.deleted`** — a template was deleted: `{"type":"template.deleted","at":1781…,"templateId":"code-review","name":"Code Review"}`

There's no built-in consumer yet — wire one to the event stream to act on these.

### Full live event catalog

All of these are published on `/ws/events` + `events.jsonl` (and recorded in sqlite, queryable via `GET /api/events?type=…`). Session-scoped events carry `templateId` when the session is a troop, so "troop X" = "session event with `templateId` set".

| Event | Fires when |
|-------|-----------|
| `session.started` | a new agent session is first seen (`templateId` ⇒ a troop's process launched) |
| `session.attention` | a session flips to blocked-waiting-on-user (the amber "needs input") — carries `ask`/`suggestion` |
| `session.errored` | a session's turn hit an API/agent error (`transient` flag) |
| `session.killed` / `session.prompted` / `session.spawned` | dismissed / prompt relayed / deploy issued |
| `troop.closed` | a templated session ended — final rollup (cost/tokens/duration/subject/summary) |
| `troop.idle` | a troop was inactive past `idleMinutes` (set `MC_IDLE_MINUTES`; off by default) — fires once until it's active again |
| `quest.completed` | a TodoWrite work item flipped to `completed` |
| `budget.exceeded` | a session's cost crossed `budgetUsd` (set `MC_BUDGET_USD`; off by default) — fires once |
| `host.online` / `host.offline` | a reporter machine connected / dropped |
| `template.created` / `template.updated` / `template.deleted` | template CRUD |
| `template.leveled_up` | a template's derived level rose (XP from its troops) — `{level, prevLevel}` |

`SessionEvent` (in `@mc/shared`) is a union, so more event types can be added
later (e.g. `session.started`, `session.errored`) and ride the same channel/log.

## Deploy a template (spawn an agent into tmux)

From the board you can deploy a templated agent — a **template** — into a new tmux
window on a host. A template is a reusable spawn recipe (provider CLI + args + initial
prompt + cwd); deploying it launches a fresh agent session in tmux on the chosen
host. Each template accumulates **XP** — a rollup over every session it has ever
spawned (troops, cost, tokens, level) — and levels up over time. Manage templates from
the roster bar at the top of the board (deploy + a template editor).

- Requires **`tmux` installed on the host running the reporter** — spawning runs
  inside that host's tmux; without it, the spawn fails.
- **Deployed agents open in your terminal** (macOS): on deploy the reporter
  targets the tmux session your terminal is attached to and switches you to the
  new window; if no terminal is attached, it opens an iTerm2/Terminal tab that
  `tmux attach`es to the session. Clicking a tmux agent's **PID** reveals its pane
  the same way.
- **Troops tile fibonacci-style**: deploys land in a per-session `agents` window
  — the first fills it, each subsequent troop splits the active pane along its
  longer axis (left/right when wide, top/bottom when tall), so panes tile like a
  spiral. Pick a specific window in the deploy form to split that one instead.
- Only pre-defined templates can be deployed: the server resolves the command from the
  stored template (never free-form input from the client), so the board can't be
  used to run arbitrary commands.
- A `session.spawned` event is published on spawn (same `/ws/events` +
  `events.jsonl`, and recorded in the SQLite `events` table).

Templates are managed over a small HTTP API — all public, same trust model as the
rest of `/api/*` and `/ws/live`:

| Method | Path |
|--------|------|
| `GET` | `/api/templates` |
| `GET` | `/api/templates/:id` |
| `POST` | `/api/templates` |
| `PATCH` | `/api/templates/:id` |
| `DELETE` | `/api/templates/:id` |

No API key or token is involved — neither to manage a template nor to deploy one.
Spawning just launches the agent's own already-authorized CLI (`claude`,
`codex`, …) in a tmux pane; there is no separate key to configure.

## Click PID to focus the terminal

Clicking a session's **PID** focuses the terminal running that agent. The browser
sends the request over the live WebSocket; the server relays it to the reporter on
that host, which runs an `osascript` (macOS):

- **iTerm2 / Apple Terminal** — selects the exact window/tab/session by tty.
- **Cursor / VS Code / kitty / Alacritty / WezTerm / Ghostty** — brings the app to
  the front (best-effort; can't target the specific pane).

Only works for agents on a host whose reporter runs on macOS, and only focuses
where that reporter runs (you can't focus a window on another machine).

## Session states

Each card reflects the session's current state, in priority order:

1. **errored** — the most recent turn ended in an API/agent error. Two grades:
   - **persistent** (solid red, pulse) — unknown/hard errors, or a sustained run
     (≥3 in a row). Never auto-expires; counted in the header.
   - **transient** (soft red, no pulse) — a short run of a known recoverable infra
     blip (`temporarily unavailable`, `overloaded`, `503/500`, `stream idle
     timeout`, the auto-mode permission classifier being briefly down). Auto-expires
     after 5 min on an idle session (assumed recovered).

   Detected for **claude** (`isApiErrorMessage` + message classification) and **pi**
   (`stopReason: "error"`). Clears immediately when a later turn succeeds. (codex's
   rollout has no clean API-error marker; hermes/openclaw don't record one.)
2. **needs input** (amber) — blocked on you (see below).
3. **active** (green) — processing.
4. idle — awaiting your next message.

Errored and needs-input sessions sort to the top, with counts in the header.

## "Needs input" detection (manual intervention)

Sessions blocked on a permission/approval/input prompt are flagged amber ("needs
input"), sorted to the top, and counted in the header — so a session waiting on
you is obvious at a glance.

- **claude**: automatic — read from `~/.claude/sessions/<pid>.json` `status: waiting`.
- **follow-up questions (all providers with recaps)**: the same Haiku call that
  writes the recap also judges (structured output) whether the assistant's latest
  message ends by asking you a question / awaiting a decision. If so, an otherwise
  *idle* session is flagged "needs input" — catching cases where the agent finished
  its turn with a question rather than a permission prompt. Throttled/cached with
  the recap, and suppressed when the session is actively processing or errored.
- **codex**: codex doesn't persist approval state (it's in-memory IPC), so it needs
  a one-time hook install:
  ```bash
  bun run install:codex-hook
  ```
  This additively registers `hooks/mc-codex-attention.sh` in `~/.codex/hooks.json`
  (backs up first, preserves existing hooks). The hook writes per-session state to
  `~/.mission-control/codex/<session_id>.json`: `PermissionRequest` marks the
  session as waiting, `UserPromptSubmit`/`PostToolUse` mark it active, and
  `Stop`/`SessionEnd` clear it. On `UserPromptSubmit`, it also delegates to the
  generic Mission Control prompt adapter so alias prompts such as
  `ask mc:a3 what service x does` can be routed through the server. Alias
  prompts are blocked by default after Mission Control intercepts them, so the
  source agent does not answer on behalf of the target. Set
  `MC_ALIAS_INTERCEPT_MODE=context` to opt back into non-blocking annotation
  mode. Restart codex sessions after installing.
- **claude**: Claude Code already exposes session status for "needs input"; to
  enable terminal prompt alias routing and routed-task completion, install the
  Mission Control hook once:
  ```bash
  bun run install:claude-hook
  ```
  This additively registers `hooks/mc-agent-prompt-hook.ts` for
  `UserPromptSubmit` and `Stop` in `~/.claude/settings.json` (backs up first,
  preserves existing hooks). Restart Claude Code sessions after installing.
- **opencode / hermes / openclaw / pi**: no local approval state (opencode uses an
  in-memory SSE prompt; pi has no documented permission/hook system; hermes/openclaw
  are autonomous daemons that escalate to you over a messaging channel), so "needs
  input" isn't detected for them yet.

## Agent handles and alias routing

Mission Control assigns every live session a server-side handle like `mc:a1`,
`mc:a2`, etc. PIDs remain internal locators; handles are what agents and users
should reference. When Haiku is configured, the server may also assign a one-word
display name for scanability, but routing never depends on it.

The router accepts:

```text
ask mc:a3 what service x does
tell mc:a3 check the failing test
ping mc:a3
mc:a3 summarize your current task
```

Provider adapters feed prompt events into `POST /api/intercept` with
`provider`, optional `providerSessionId`, optional `cwd`, and `prompt`. Providers
that expose a completion/stop event can also feed the latest assistant message to
`POST /api/complete`, allowing the target's terminal answer to route back to the
source. Codex and Claude Code use thin hook adapters for `UserPromptSubmit` and
`Stop`; the server-side routing logic is provider-agnostic and can be reused by
OpenCode, Pi, Hermes, or other agents when they expose equivalent hook or message
surfaces. Terminal interception only blocks the local prompt after a safe route is
created; if Mission Control cannot identify the source session or detects a
self-route, the hook leaves the prompt unblocked and reports the issue as context.

## Session recaps (Haiku)

When `ANTHROPIC_API_KEY` is set on the reporter, each session's summary is a
one-line recap generated by **Claude Haiku 4.5** from the tail of that session's
transcript — far more useful than the raw last-message heuristic. To keep cost
and latency down, recaps run **in the background** and are cached per session by
content hash: a session is only re-summarized when its transcript changes and at
most once per `MC_SUMMARY_INTERVAL_MS`. The recap appears one tick after it's
ready. With no API key (or `MC_SUMMARIES=0`), it falls back to the heuristic
summary and shows everything else unchanged.

## History (persisted sessions)

The live board only shows sessions whose process is running right now — but the
server also keeps a durable record of everything it has seen in a SQLite file at
`~/.mission-control/mc.db` (override with `MC_DB`). This is a write-only sidecar:
it never affects the live board, so a server restart loses nothing historical.

Switch the dashboard's top **Live / History** toggle to browse it:

- Every session ever seen is kept forever in a registry, with a lifecycle state:
  `running`, `closed` (its process exited), or `orphaned` (its host's reporter
  went away — the process may still be alive, we just lost sight of it).
- Each closed/orphaned session shows cost/token/context **sparklines** over its
  lifetime and a **timeline** of its events (started, tool use, errors,
  active/needs-input flips, kill/prompt, and any A2A task routing).
- A one-click **resume** button copies a provider-specific command (e.g.
  `cd '/repo' && claude --resume <id>`) to relaunch that session. Disabled when
  the provider didn't expose a resumable session id.

Behind the scenes the time-series is downsampled as it ages (raw → hourly →
daily) and capped by a size ceiling, all tunable via the retention settings (see
[Config](#config) / [Settings](#settings)). The same data is available over a
small read-only HTTP API: `GET /api/sessions`, `/api/sessions/:key`,
`/api/sessions/:key/samples`, `/api/events` (same trust posture as `/ws/live`).

`/api/sessions` accepts `state`, `provider`, `category`, `cwd`, `since`, `until`,
`minTokens`, plus unified search/sort: `q` (whitespace-split terms ANDed across
display name/subject/summary/cwd/handle/provider/model — running rows included),
`sort` (`lastSeen`|`started`|`cost`|`tokens`|`context`) and `order`
(`asc`|`desc`), with `limit`/`offset`. Leaderboards are just `sort=cost&limit=N`.
Three more read endpoints back the dashboard/quest UI:

- `GET /api/facets` — self-excluding filter-chip counts (`providers`,
  `categories`, `hosts`, `states`); takes the same filters as `/api/sessions`.
- `GET /api/stats/timeseries` — bucketed cost/token rollup. Params: `since`,
  `until` (required), `bucket` (`hour`|`day`), `metric` (`cost`|`tokens`),
  `groupBy` (`none`|`category`|`provider`), optional `provider`/`category`/`host`
  scope. Per-session delta over cumulative samples, reads across resolutions for
  long windows. Bad/missing params → 400.
- `GET /api/quests` (cross-session board; filters `status`, `provider`,
  `category`, `state`) and `GET /api/sessions/:key/quests` — kanban work items
  ("quests") sourced passively from Claude/OpenClaw `TodoWrite` lists.

## Backfill (import history)

The live server only records sessions while it is running. To seed the history
DB with **past** sessions already on disk — Claude, Codex, OpenCode, OpenClaw,
and Hermes transcripts — run the standalone backfill CLI:

```bash
bun run backfill
```

It reads each provider's on-disk session store directly (reusing the reporter's
parsers), writes closed-session registry rows + hour-resolution sparkline
samples into the same SQLite file the server uses (`~/.mission-control/mc.db`,
override with `MC_DB`), and prints a per-provider report. It is a separate
process: it does **not** talk to or require a running server.

```bash
bun run backfill --providers claude,codex     # only these adapters
bun run backfill --dry-run                     # parse + tally, write nothing
bun run backfill --include-hermes-cron         # also import hermes cron sessions
ANTHROPIC_API_KEY=… bun run backfill --enrich-only   # (re)enrich existing rows only
```

| Flag | Effect |
|------|--------|
| `--providers a,b` | Only run these adapter ids (default: every adapter whose store exists). |
| `--include-hermes-cron` | Include Hermes `cron`-source sessions (skipped by default). |
| `--no-enrich` | Skip the Haiku enrichment phase. |
| `--enrich-only` | Skip the import phase; only run enrichment over existing rows whose summary is still NULL. |
| `--batch-size N` | Sessions per Haiku enrichment call (default 15). |
| `--dry-run` | Parse and tally would-be imports, but write nothing (also skips enrichment). |

Behavior:

- **Idempotent** — imports skip-if-exists by session key, and a **running/live
  row is never clobbered** (live data always wins). Re-running only imports
  sessions not already in the DB, so it is safe to run repeatedly.
- **Graceful degradation** — a provider, session, or field that fails to parse
  is skipped/nulled rather than aborting the run; the end-of-run report tallies
  imported / skipped / failed per provider.
- **Resume** — backfilled sessions carry a resume command where the provider
  exposes a resumable id: Claude, Codex (`codex resume <uuid>`), OpenClaw, and
  `cli`-source Hermes (`hermes --resume <id>`). OpenCode has no resume id, so its
  resume button is disabled.
- **Samples** — only hour-resolution sparkline points are written (from
  providers with per-turn timestamps); Hermes has none, so it imports a row with
  no time-series.
- **Enrichment** — when `ANTHROPIC_API_KEY` is set, an optional phase generates
  subject / summary / needs-action recaps with batched Haiku for rows missing
  them. Without the key it is skipped silently; pass `--no-enrich` to always skip
  it, or `--enrich-only` to (re)enrich existing rows without re-importing.

## Known limitations

- Enrichment (tokens, model, tools, recap input) requires a parseable session
  store. Supported providers:
  - **claude** — `~/.claude/projects/**` JSONL, matched by `cwd`
  - **codex** — `~/.codex/sessions/**/rollout-*.jsonl`, matched by `session_meta.cwd`
  - **opencode** — `~/.local/share/opencode/storage/**`, matched by `session.directory`
  - **hermes** — `~/.hermes/state.db` (SQLite); single gateway, so the most
    recently-started session is used (not cwd-scoped)
  - **openclaw** — `~/.openclaw/agents/<agent>/sessions/` (claude-shaped JSONL);
    daemon, so the most recently-updated session across agents is used. Reuses
    the claude transcript parser since OpenClaw wraps Claude Code.
  - **pi** — `~/.pi/agent/sessions/**` JSONL, matched by the session header's
    `cwd`. Uses pi's own per-message `usage.cost.total` for cost. Built from pi's
    documented session format; not yet verified against a live pi install
    (validate when pi is present).
- Enrichment maps a process's `cwd` to the **newest** transcript for that project,
  so multiple sessions sharing one cwd may report the same totals.
- claude totals are cumulative for the matched transcript; cache-read tokens are
  priced at 10% of input (Anthropic's cache discount).
- Cost uses an approximate list-price table in `packages/shared/src/cost.ts`.
