# Agents Mission Control — Design

Date: 2026-06-15

## Goal

Web dashboard showing every **currently-open AI agent session** across all
providers (Claude Code, Codex, OpenCode, pi, Hermes, future agents) and across
**multiple machines**. "Open" = a live agent process is running right now.

## Decisions

- **Open = live process.** Sessions vanish from the board when the process dies.
- **Multi-machine.** A reporter runs on every host.
- **Transport: WebSocket push.** Reporters dial the central server, push snapshots.
- **Per session show:** provider, pid, host, cwd, uptime, cpu/mem, plus best-effort
  enrichment — session summary, tokens in/out, custom tools used, model, estimated cost.
- **"Proficiency" = role/category** the agent is used for (code / review / research /
  personal / vault …). Driven by an overridable config map; extensible for new agents.
- **Stack: Bun + TypeScript** end to end. React for UI. No DB (state is ephemeral).

## Architecture

Monorepo (Bun workspaces):

```
packages/
  shared/    # TS types, cost table, category resolution (pure, tested)
  reporter/  # per-host: proc scan + provider plugins + WS client; compiles to single binary
  server/    # Bun.serve WS hub: /ws/report in, /ws/live out, serves web bundle
  web/        # React dashboard, live grid
```

Flow: reporter scans procs every ~3s → enriches via provider plugins → pushes
`HostReport` over WS. Server keeps `Map<hostId, HostReport>`, marks hosts stale after
`STALE_MS`, broadcasts merged state to browsers. In-memory only.

## Provider registry

Each provider is a plugin: `matchProcess(p)`, `defaultCategory`, optional
`enrich(p)` that reads that provider's session file (claude JSONL, codex history.jsonl,
…). Enrichment is best-effort and per-session try/catch — missing data renders "—",
never blocks the session.

## Protocol

Reporter→server: `hello{hostId,label,token}`, `report{HostReport}`, `ping`.
Server→web: `state{hosts[]}`, `patch{report}`, `offline{hostId}`.
Full host snapshot each tick (session sets are tiny) — no delta reconciliation.

## Auth / deploy

Shared `MC_TOKEN` on reporters. Server binds localhost by default; recommended
multi-machine path is Tailscale. Reporter ships as `bun build --compile` single-file
binary, run via launchd (mac) / systemd (linux).

## Testing

`bun test`: cost calc + category resolution (pure), provider plugins (golden fixtures),
proc scan (injected `ps` output), server WS lifecycle + token rejection, web card render.
