/**
 * iTerm2 native-pane deploys (macOS). Mirrors tmux.ts's best-effort/never-throw
 * contract. Each deploy splits the previous agent's pane along its longer axis
 * (fibonacci spiral) — or opens a new window for the first troop — and runs the
 * agent with `env MC_TEMPLATE_ID=<id>` so the reporter's procscan can tag lineage.
 *
 * Panes are addressed by iTerm2 session id (a stable UUID). We remember the last
 * agent's session id in module state so consecutive deploys chain into a spiral.
 */
import { statSync } from "node:fs";
import { shellQuote, normalizeTty, type SpawnPlan, type SpawnResult } from "./tmux.ts";
import type { ItermTab } from "@mc/shared";

/** iTerm2 session id of the most recently deployed troop — the spiral's growing
 * tip. Resets on reporter restart (first deploy then opens a fresh window). */
let lastAgentSession: string | null = null;

async function osa(script: string): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    return { ok: p.exitCode === 0, out };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Escape a string for an AppleScript double-quoted literal. */
const asStr = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Parse `<sessionId>\t<title>` lines (records joined by \n) into tabs. Pure. */
export function parseItermTabs(out: string): ItermTab[] {
  const tabs: ItermTab[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const sessionId = line.slice(0, tab);
    if (sessionId) tabs.push({ sessionId, title: line.slice(tab + 1) });
  }
  return tabs;
}

/** List iTerm2 tabs (each tab's current session) as deploy targets. Best-effort:
 * [] when iTerm isn't running or off-darwin. Never throws. */
export async function listItermTabs(): Promise<ItermTab[]> {
  if (process.platform !== "darwin") return [];
  // tab-separate id/title per record, newline between records; "" if iTerm is down
  const script = `with timeout of 8 seconds
if application "iTerm2" is not running then return ""
set out to ""
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      set s to (current session of t)
      set out to out & (id of s) & "	" & (name of s) & linefeed
    end repeat
  end repeat
end tell
return out
end timeout`;
  const res = await osa(script);
  return res.ok ? parseItermTabs(res.out) : [];
}

/** The shell line typed into the new pane: cd (optional) + env-tagged agent.
 * `env VAR=val cmd` is shell-agnostic, and each token is shell-quoted. Pure. */
export function buildLaunchLine(cmd: string, args: string[], templateId: string, cwd?: string | null): string {
  const agent = [cmd, ...args].map(shellQuote).join(" ");
  let line = `env MC_TEMPLATE_ID=${shellQuote(templateId)} ${agent}`;
  if (cwd) line = `cd ${shellQuote(cwd)} && ${line}`;
  return line;
}

/** Deploy a troop into an iTerm2 native pane. Never throws. */
export async function spawnIterm(plan: SpawnPlan): Promise<SpawnResult> {
  if (process.platform !== "darwin") return { ok: false, error: "iterm2 backend is macOS-only" };
  if (plan.cwd) {
    try {
      if (!statSync(plan.cwd).isDirectory()) return { ok: false, error: "cwd not a directory: " + plan.cwd };
    } catch {
      return { ok: false, error: "cwd not a directory: " + plan.cwd };
    }
  }
  const line = asStr(buildLaunchLine(plan.cmd, plan.args, plan.templateId, plan.cwd));
  // explicit target (an iTerm session id picked in the deploy form) → split it;
  // else chain off the last deployed pane (spiral); else open a fresh window.
  const last = plan.windowId ?? lastAgentSession ?? "";
  // optional marching-orders prompt, typed after the agent's TUI settles
  const promptStep = plan.prompt ? `\n  delay 0.6\n  tell newS to write text "${asStr(plan.prompt)}"` : "";
  const script = `with timeout of 25 seconds
tell application "iTerm2"
  activate
  set target to missing value
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (id of s) is "${last}" then set target to s
      end repeat
    end repeat
  end repeat
  if target is missing value then
    set wN to (create window with default profile)
    set newS to (current session of wN)
  else
    set c to (columns of target)
    set r to (rows of target)
    if c > (2 * r) then
      tell target to set newS to (split vertically with default profile)
    else
      tell target to set newS to (split horizontally with default profile)
    end if
  end if
  tell newS to write text "${line}"${promptStep}
  return (id of newS) & "	" & (tty of newS)
end tell
end timeout`;
  const res = await osa(script);
  if (!res.ok || !res.out) return { ok: false, error: "iterm spawn failed" + (res.out ? ": " + res.out : "") };
  const [id, ttyRaw] = res.out.split("\t");
  if (!id) return { ok: false, error: "iterm spawn: no session id" };
  lastAgentSession = id;
  return { ok: true, paneId: id, tty: ttyRaw ? normalizeTty(ttyRaw) : undefined };
}
