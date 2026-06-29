/**
 * Focus the terminal running a given pid (macOS).
 * - iTerm2 / Apple Terminal: select the exact tab/session by tty.
 * - Other hosts (Cursor, VS Code, kitty, alacritty, wezterm, ghostty): bring the
 *   app to the front (best-effort — can't target the specific pane).
 */

async function run(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out;
  } catch {
    return "";
  }
}

/** Controlling tty of a pid, e.g. "ttys001" (sanitized), or null. */
async function ttyOf(pid: number): Promise<string | null> {
  const out = await run(["ps", "-o", "tty=", "-p", String(pid)]);
  return /^ttys\d+$/.test(out) ? out : null;
}

/** Walk the pid's ancestry; return the host terminal app's name to activate. */
async function ownerApp(pid: number): Promise<string | null> {
  let cur = pid;
  for (let i = 0; i < 12 && cur > 1; i++) {
    const out = await run(["ps", "-o", "ppid=,command=", "-p", String(cur)]);
    const m = out.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) break;
    const cmd = m[2]!;
    if (/iTerm\.app|iTermServer/.test(cmd)) return "iTerm";
    if (/Terminal\.app/.test(cmd)) return "Terminal";
    if (/Cursor\.app/.test(cmd)) return "Cursor";
    if (/Visual Studio Code|Code\.app|Code Helper/.test(cmd)) return "Visual Studio Code";
    if (/kitty/.test(cmd)) return "kitty";
    if (/alacritty/i.test(cmd)) return "Alacritty";
    if (/wezterm/i.test(cmd)) return "WezTerm";
    if (/ghostty/i.test(cmd)) return "Ghostty";
    cur = Number(m[1]);
  }
  return null;
}

/** AppleScript to select an iTerm2/Terminal session by its tty and activate. */
function ttySelectScript(app: "iTerm2" | "Terminal", devTty: string): string {
  if (app === "iTerm2") {
    return `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${devTty}" then
          select w
          select t
          select s
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "not-found"`;
  }
  return `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${devTty}" then
        set selected tab of w to t
        set index of w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "not-found"`;
}

/** ttys of the foreground session in each running terminal app (iTerm/Terminal). */
export async function focusedTtys(): Promise<Set<string>> {
  const set = new Set<string>();
  if (process.platform !== "darwin") return set;
  const script = `set out to ""
if application "iTerm2" is running then
  try
    tell application "iTerm2" to set out to out & (tty of current session of current window) & "|"
  end try
end if
if application "Terminal" is running then
  try
    tell application "Terminal" to set out to out & (tty of selected tab of front window) & "|"
  end try
end if
return out`;
  const raw = await run(["osascript", "-e", script]);
  for (const part of raw.split("|")) {
    const m = part.trim().match(/ttys\d+$/);
    if (m) set.add(m[0]);
  }
  return set;
}

/** Type text into the terminal session running `pid` (as if the user typed it + Enter). */
export async function sendText(pid: number, text: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const owner = await ownerApp(pid);
  if (owner !== "iTerm" && owner !== "Terminal") return false; // only tty-addressable terminals
  const tty = await ttyOf(pid);
  if (!tty) return false;
  // single line + Enter; escape for an AppleScript double-quoted string
  const safe = text.replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const dev = `/dev/${tty}`;
  const script =
    owner === "iTerm"
      ? // Type the text and the Enter as two separate writes with a small gap.
        // A single `write text` sends "<text>\r" as one burst, which agent TUIs
        // (Claude Code, Codex) treat as a paste — the trailing newline lands as a
        // literal line break instead of submitting. Sending CR on its own makes it
        // an unambiguous Enter keypress.
        `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${dev}" then
          tell s to write text "${safe}" newline NO
          delay 0.05
          tell s to write text (character id 13) newline NO
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "not-found"`
      : `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${dev}" then
        do script "${safe}" in t
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "not-found"`;
  return (await run(["osascript", "-e", script])) === "ok";
}

export async function focusPid(pid: number): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const owner = await ownerApp(pid);

  // Exact tab/session selection for iTerm2 + Apple Terminal.
  if (owner === "iTerm" || owner === "Terminal") {
    const tty = await ttyOf(pid);
    if (tty) {
      const out = await run([
        "osascript",
        "-e",
        ttySelectScript(owner === "iTerm" ? "iTerm2" : "Terminal", `/dev/${tty}`),
      ]);
      if (out === "ok") return true;
    }
  }

  // Best-effort: bring the host app to the front.
  if (owner) {
    await run(["open", "-a", owner === "iTerm" ? "iTerm" : owner]);
    return true;
  }

  // No terminal app in the ancestry → likely a tmux-spawned agent (its parent is
  // the daemonized tmux server). Locate its pane and reveal it in a terminal.
  const pane = await tmuxPaneOf(pid);
  if (pane) return revealTmux(pane.session, pane.windowId, pane.paneId);
  return false;
}

// --- tmux pane reveal (for agents deployed into tmux by the templates feature) ---

export type PaneRef = { session: string; windowId: string; paneId: string };

/** Parse `tmux list-panes -a -F '#{pane_pid}\t#{session_name}\t#{window_id}\t#{pane_id}'`
 * into a pane_pid → pane map. Pure. */
export function parsePanePidMap(out: string): Map<number, PaneRef> {
  const map = new Map<number, PaneRef>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [pidStr, session, windowId, paneId] = line.split("\t");
    const pp = Number(pidStr);
    if (!Number.isFinite(pp) || !session || !windowId || !paneId) continue;
    map.set(pp, { session, windowId, paneId });
  }
  return map;
}

async function ppidOf(pid: number): Promise<number> {
  const n = Number((await run(["ps", "-o", "ppid=", "-p", String(pid)])).trim());
  return Number.isFinite(n) ? n : 0;
}

/** Find the tmux pane a pid lives in by walking its parent chain until an
 * ancestor matches a pane's root pid (the agent runs as a child of the pane
 * shell, so its own pid won't be the pane_pid). Null if not under tmux. */
export async function tmuxPaneOf(pid: number): Promise<PaneRef | null> {
  const map = parsePanePidMap(
    await run(["tmux", "list-panes", "-a", "-F", "#{pane_pid}\t#{session_name}\t#{window_id}\t#{pane_id}"]),
  );
  if (map.size === 0) return null;
  let cur = pid;
  for (let i = 0; i < 16 && cur > 1; i++) {
    const hit = map.get(cur);
    if (hit) return hit;
    cur = await ppidOf(cur);
  }
  return null;
}

/** Which terminal app is running (prefer iTerm2), for opening an attach tab. */
async function runningTerminal(): Promise<"iTerm2" | "Terminal" | null> {
  const out = await run([
    "osascript",
    "-e",
    `set r to ""
if application "iTerm2" is running then set r to "iTerm2"
if r is "" and application "Terminal" is running then set r to "Terminal"
return r`,
  ]);
  return out === "iTerm2" ? "iTerm2" : out === "Terminal" ? "Terminal" : null;
}

const shSingle = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const asStr = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Open a new terminal tab/window that attaches to a tmux session. */
async function openTerminalAttached(session: string): Promise<boolean> {
  const term = await runningTerminal();
  if (!term) return false;
  const cmd = asStr(`exec tmux attach -t ${shSingle(session)}`);
  const script =
    term === "iTerm2"
      ? `tell application "iTerm2"
  activate
  if (count of windows) = 0 then
    set w to (create window with default profile)
  else
    set w to current window
  end if
  tell w
    set t to (create tab with default profile)
    tell current session of t to write text "${cmd}"
  end tell
end tell
return "ok"`
      : `tell application "Terminal"
  activate
  do script "${cmd}"
  return "ok"
end tell`;
  return (await run(["osascript", "-e", script])) === "ok";
}

/** Make a tmux pane visible in a terminal: select it within tmux, then focus the
 * terminal already attached to its session — or, if none is attached, open a new
 * terminal tab that attaches. macOS only; best-effort, never throws. */
export async function revealTmux(session: string, windowId?: string, paneId?: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  if (windowId) await run(["tmux", "select-window", "-t", windowId]);
  if (paneId) await run(["tmux", "select-pane", "-t", paneId]);

  const clients = (await run(["tmux", "list-clients", "-t", session, "-F", "#{client_tty} #{client_pid}"]))
    .split("\n").map((s) => s.trim()).filter(Boolean);
  if (clients.length > 0) {
    const [ctty, cpidStr] = clients[0]!.split(/\s+/);
    const cpid = Number(cpidStr);
    const capp = Number.isFinite(cpid) ? await ownerApp(cpid) : null;
    if ((capp === "iTerm" || capp === "Terminal") && ctty) {
      const out = await run(["osascript", "-e", ttySelectScript(capp === "iTerm" ? "iTerm2" : "Terminal", ctty)]);
      if (out === "ok") return true;
    }
    if (capp) { await run(["open", "-a", capp === "iTerm" ? "iTerm" : capp]); return true; }
    return true; // attached to an unknown terminal; the pane is at least selected
  }
  // nobody attached → open a terminal that attaches to this session
  return openTerminalAttached(session);
}
