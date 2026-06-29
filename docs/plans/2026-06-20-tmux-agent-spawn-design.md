# Spawn agents into tmux from Mission Control — design

**Date:** 2026-06-20
**Status:** Implemented (v1) on branch feature/tmux-spawn.

## Goal

Deploy a new agent session from the Mission Control board into a tmux window on a
host. Spawning is template-driven: a reusable **template** defines what
to launch (provider CLI + args + initial prompt). Each template accumulates **XP** —
a rollup over every agent session it has ever spawned — and levels up over time.

RPG framing (matches the existing Final Fantasy party-board theme):

- **Template** = a replicable spawn recipe. Earns XP.
- **Troop** = an agent session deployed by a template.
- **Quest** = a tmux window (the "tab") that groups troops.

## tmux mapping (load-bearing)

```
session: <current/most-recent on host, created if none>   ← workspace, transparent
  window @4   ← a quest "tab"        (grouping unit)
    pane %7   ← agent A (troop)
    pane %8   ← agent B (future: multiple troops per quest)
  window @5   ← another quest
```

- **session** = the user's current/most-recent tmux session on the host
  (`tmux display -p '#S'` style; fall back to `tmux new-session -d` if none).
  No picker — transparent.
- **window** = a quest "tab" — the grouping unit, named after the template/quest.
- **pane** = one agent session. v1 typically creates a new window per spawn;
  the near-future feature is splitting additional panes into an existing quest
  window. We capture and store window+pane ids now so that targeting works later.

## Architecture: a 4th verb on the existing reverse channel

The reverse channel already exists (`ServerToReporterMsg = focus | kill | prompt
| config`). Spawn is a new verb on the same path — no architecture change.

```
web: deploy [template] → [host] (+ new window | existing quest window)
  → /ws/live   { type:'spawn', hostId, templateId, windowId?, cwd?, promptOverride? }

server (index.ts edge):
  - look up template in DB (templates table)
  - resolve launch: provider cmd + args + initial prompt
  - reporters.get(hostId).send({ type:'spawn', templateId, cmd, args, prompt, cwd, windowId? })

reporter (new tmux.ts):
  S = resolveSession()                         # current/most-recent, else create
  if windowId alive: tmux split-window -t windowId        # new pane in quest tab
  else:              tmux new-window  -t S -n <template-name>  # new quest tab
  capture ids with -PF '#{window_id} #{pane_id}'
  send-keys (argv, not shell): MC_TEMPLATE_ID=<id> <cmd> <args> Enter ; [prompt Enter]
  → ack { type:'spawned', ok, templateId, windowId, paneId, error? }
```

Host is an explicit param. UI is transparent when there is one host; a host
picker appears only when >1 reporter is connected.

## Data model (store.ts)

```sql
CREATE TABLE templates (             -- the templates
  id          TEXT PRIMARY KEY,      -- kebab slug, e.g. 'code-review'
  name        TEXT NOT NULL,         -- 'Code Review Template'
  provider    TEXT NOT NULL,         -- claude | codex | opencode | ...
  args_json   TEXT,                  -- ['--model','o1']
  prompt      TEXT,                  -- initial prompt (nullable)
  cwd         TEXT,                  -- default cwd (nullable → chosen at spawn)
  rpg_json    TEXT,                  -- class/sprite/color for the card
  created_at  INTEGER,
  archived_at INTEGER                -- soft delete
);

ALTER TABLE sessions ADD COLUMN template_id TEXT;   -- lineage (nullable)
```

### Lineage (spawned session → template)

procscan discovers processes generically — nothing inherently links a new pane's
process to its template. We tag it:

- Reporter launches the pane with `MC_TEMPLATE_ID=<id>` in the command.
- procscan reads the env of tracked agent pids — `ps eww -p <pid>` on darwin,
  `/proc/<pid>/environ` on linux — and extracts `MC_TEMPLATE_ID` →
  `Session.templateId`. Best-effort / wrapped, never throws (same contract as
  `enrich()`).
- Rides through `collect` → `HostReport` → `hub.ingest` → `store.record`, which
  sets `sessions.template_id`.

### XP = derived on read (no stored counter, no drift)

```sql
SELECT template_id,
       COUNT(*)       AS troops_deployed,
       SUM(cost_usd)  AS total_cost,
       SUM(tokens)    AS total_tokens,
       MAX(last_seen) AS last_deploy
FROM sessions WHERE template_id = ? GROUP BY template_id;
```

`template_id` persists after a session closes, so a template retains XP from dead
troops — intended. Level is a function of the rollups, computed in `rpg.ts`
alongside the existing character math.

## API

```
GET    /api/templates            public   list + derived XP
GET    /api/templates/:id        public
POST   /api/templates            public   create template
PATCH  /api/templates/:id        public   edit
DELETE /api/templates/:id        public   archive (soft)
```

All endpoints are public — same trust model as the rest of `/api/*` and
`/ws/live`. (An earlier revision token-gated the writes, but that was dropped:
`/ws/live` already allows unauthed kill/prompt and template *deploys*, so gating
only template *creation* protected nothing the open deploy channel didn't already
expose. The app's stance is "trust the network/localhost," and template management
now matches it. No API key is involved anywhere — spawning launches the agent's
existing CLI login.)

## Security (spawn = remote command execution)

`/ws/live` is an open trust channel (kill/prompt/focus are not per-message
authed; kill is safe only because the reporter guards to known pids). Spawn has
no natural pid guard, so the defenses are:

1. **Template is the guard.** The reporter only ever runs a command resolved from
   an existing template. The server never forwards a free-form string. No template →
   no spawn. (Template management is public — see API above — consistent with the
   open `/ws/live` channel that already exposes kill/prompt/deploy.)
2. **No shell interpolation.** Build argv directly
   (`Bun.spawn(['tmux','send-keys','-t',pane,'-l',literalText])` then a separate
   `Enter` key). Prompt/args can't break out of the command.
3. **cwd validation.** Must exist and be a directory, else reject.
4. **Rate cap.** Reject if more than N panes were created on the host in the last
   ~10s — stops a runaway board from fork-bombing a host.

Spawn ack writes a `session.spawned` event, dual-written to `events.jsonl` and
the sqlite `events` table (consistent with the existing event model).

## Web UI (Final Fantasy party-board theme)

- **Templates roster** (`TemplatesBar.tsx` / panel): each template is a card — class/sprite,
  level, XP bar, troops deployed, total cost. Reuses `rpg.ts` + `CharacterCard`.
- **Deploy action**: button on a template → small form: target host (auto if 1), cwd
  (prefilled from template default), "new quest window" vs "into existing window"
  (dropdown of tracked live windows for that host), optional prompt override.
  Fires the `spawn` WS message.
- **Template editor**: create/edit form → `POST/PATCH /api/templates`.
  Token entered once, stored in `prefs.ts` like other client prefs.
- **Feedback**: toast on `spawned` ack; the new troop appears on the board within
  a tick (normal report cycle), already tagged to its template.

## Reporter module

`packages/reporter/src/tmux.ts` (side-effects at the edge, like `kill.ts` /
`focus.ts`):

- `resolveSession()` → current/most-recent tmux session, else create.
- `spawn({cmd, args, prompt, cwd, windowId})` → builds argv, runs tmux, returns
  `{windowId, paneId}` or throws (caller wraps in try/catch).
- Wired into `reporter/src/index.ts` beside the existing kill/focus/prompt
  handlers. Env-read for lineage lives in `procscan.ts` / `collect.ts`.

## Testing (pure-function-first)

- `tmux.ts`: argv-builder tested pure — prompt with quotes/newlines → correct
  argv, no shell injection. tmux exec mocked.
- `store.ts`: template CRUD + XP rollup query on in-memory DB — troops across
  open/closed sessions sum correctly; archived template excluded from list but XP
  retained.
- env-parse for `MC_TEMPLATE_ID` from `ps eww` / `environ` sample text — pure.
- `hub`/router: `spawn` request routes to the correct host reporter; ack updates
  nothing live (lineage arrives via the normal report cycle).

## Wire protocol additions (shared/types.ts)

```ts
// web → server
type SpawnRequest = { type:'spawn'; hostId:string; templateId:string;
                      windowId?:string; cwd?:string; promptOverride?:string };

// server → reporter
type SpawnMsg = { type:'spawn'; templateId:string; cmd:string; args:string[];
                  prompt?:string; cwd?:string; windowId?:string };

// reporter → server
type SpawnedMsg = { type:'spawned'; ok:boolean; templateId:string;
                    windowId?:string; paneId?:string; error?:string };

// Session gains:
templateId?: string;
```

## Phasing

1. **v1**: templates table + CRUD (public) + spawn (new window per deploy) +
   lineage tagging + derived XP + templates roster UI.
2. **Near future**: split additional panes into an existing quest window
   (multi-troop quests) — window targeting already plumbed via stored ids.
3. **Later**: quest-specific context injected into the spawn prompt.
```
