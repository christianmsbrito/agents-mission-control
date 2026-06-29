#!/bin/sh
# Mission Control codex hook — records live state and forwards prompts to the
# provider-agnostic Mission Control prompt interceptor.
#
# Codex persists no busy/idle or approval state, so the reporter can't read it
# from a session file (unlike claude's `status`). This observe-only hook writes a
# per-session flag the reporter reads, deriving both signals from the lifecycle:
#   UserPromptSubmit / PostToolUse -> active=true  (turn started / mid-turn, processing)
#   PermissionRequest              -> attention=true, active=false (blocked on user)
#   Stop / SessionEnd              -> active=false, attention=false (idle / gone)
# Prompt interception is best-effort. On UserPromptSubmit and Stop, this script
# delegates to hooks/mc-agent-prompt-hook.ts with MC_AGENT_PROVIDER=codex. If Bun
# or the Mission Control server is unavailable, Codex continues normally.
#
# Pure POSIX sh on purpose: no python/node/bun, no version manager, no PATH deps.

input=$(cat)
event=$(printf '%s' "$input" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -z "$event" ] && event=$(printf '%s' "$input" | sed -n 's/.*"hookEventName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

case "$event" in
  UserPromptSubmit|PostToolUse) act=true;  att=false ;;
  PermissionRequest)            act=false; att=true ;;
  Stop|SessionEnd)              act=false; att=false ;;
  *) exit 0 ;;
esac
[ -z "$sid" ] && exit 0

dir="$HOME/.mission-control/codex"
mkdir -p "$dir" 2>/dev/null || exit 0
now=$(( $(date +%s) * 1000 ))
printf '{"active":%s,"attention":%s,"at":%s,"cwd":"%s"}' "$act" "$att" "$now" "$cwd" > "$dir/$sid.json" 2>/dev/null

if { [ "$event" = "UserPromptSubmit" ] || [ "$event" = "Stop" ]; } && command -v bun >/dev/null 2>&1; then
  MC_AGENT_PROVIDER=codex bun "$(dirname "$0")/mc-agent-prompt-hook.ts" <<EOF 2>/dev/null
$input
EOF
fi
exit 0
