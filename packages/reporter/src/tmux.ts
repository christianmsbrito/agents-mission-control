/**
 * tmux command helpers for spawning agent sessions. Pure argv builders are
 * exported for testing; the executor (`spawn`) runs tmux and never throws — it
 * returns a result object, matching the best-effort contract of kill.ts/focus.ts.
 *
 * Commands are built as argv (never an interpolated shell string), and the launch
 * line is typed into the pane with `send-keys -l` (literal) so a prompt/arg cannot
 * break out into tmux key-name interpretation. Lineage (MC_TEMPLATE_ID) is set via
 * tmux's own `-e` flag on window/pane creation — shell-agnostic, so it survives
 * fish/nu where POSIX inline-env syntax would silently drop it.
 */
import { statSync } from "node:fs";
import type { TmuxWindow } from "@mc/shared";
import { revealTmux } from "./focus.ts";

const PRINT = ["-P", "-F", "#{window_id} #{pane_id}"] as const;

/** Tab-separated format for `tmux list-windows -a`. */
const WINDOW_FMT = "#{window_id}\t#{window_name}\t#{session_name}\t#{window_active}";

/** Parse `tmux list-windows -a -F <WINDOW_FMT>` output into TmuxWindow rows. Pure. */
export function parseTmuxWindows(out: string): TmuxWindow[] {
  const rows: TmuxWindow[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [id, name, session, active] = line.split("\t");
    if (!id || !session) continue; // malformed
    rows.push({ id, name: name ?? "", session, active: active === "1" });
  }
  return rows;
}

/** Render an env map into `-e KEY=VAL` argv entries (stable key order). */
function envArgs(env?: Record<string, string>): string[] {
  if (!env) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) out.push("-e", `${k}=${v}`);
  return out;
}

export function newWindowArgs(
  session: string,
  name: string,
  cwd?: string | null,
  env?: Record<string, string>,
): string[] {
  const a = ["new-window", "-t", session, "-n", name];
  if (cwd) a.push("-c", cwd);
  return [...a, ...envArgs(env), ...PRINT];
}
export function splitWindowArgs(
  target: string,
  cwd?: string | null,
  env?: Record<string, string>,
  dir?: "-h" | "-v",
): string[] {
  const a = ["split-window"];
  if (dir) a.push(dir); // -h = left/right, -v = top/bottom; omit = tmux default
  a.push("-t", target);
  if (cwd) a.push("-c", cwd);
  return [...a, ...envArgs(env), ...PRINT];
}
/** send-keys with -l writes the string LITERALLY (no key-name interpretation). */
export function launchKeysArgs(paneId: string, line: string): string[] {
  return ["send-keys", "-t", paneId, "-l", line];
}
export function enterKeysArgs(paneId: string): string[] {
  return ["send-keys", "-t", paneId, "Enter"];
}

/** Shell-quote a single token for the launch line typed into the pane. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Let the agent TUI's input box settle before typing the prompt (ms). */
const PROMPT_READY_MS = 150;

export type SpawnPlan = {
  cmd: string; args: string[]; prompt?: string; cwd?: string | null;
  templateId: string; name: string; windowId?: string;
};
export type SpawnResult = { ok: boolean; windowId?: string; paneId?: string; tty?: string; error?: string };

/** Strip a leading /dev/ so a tty matches `ps`/procscan form ("ttys023"). Pure. */
export function normalizeTty(tty: string): string {
  return tty.trim().replace(/^\/dev\//, "");
}

async function tmux(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()).trim();
    const err = (await new Response(p.stderr).text()).trim();
    await p.exited;
    return { ok: p.exitCode === 0, out, err };
  } catch {
    return { ok: false, out: "", err: "" };
  }
}

/** List all tmux windows across sessions on this host. Best-effort: returns []
 * when no tmux server is running (or tmux isn't installed). Never throws. */
export async function listWindows(): Promise<TmuxWindow[]> {
  const r = await tmux(["list-windows", "-a", "-F", WINDOW_FMT]);
  return r.ok ? parseTmuxWindows(r.out) : [];
}

/** Pick the session of the most-recently-active attached client — the tmux
 * session in the terminal the user is actually looking at — from
 * `tmux list-clients -F '#{client_activity}\t#{session_name}'`. Pure; null when
 * no client is attached. */
export function pickAttachedSession(out: string): string | null {
  let best: { activity: number; session: string } | null = null;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const activity = Number(line.slice(0, tab));
    const session = line.slice(tab + 1);
    if (!session || Number.isNaN(activity)) continue;
    if (!best || activity > best.activity) best = { activity, session };
  }
  return best ? best.session : null;
}

/** Resolve the session deployed agents should land in. Prefers the session of
 * the attached client (the terminal the user is viewing) so deploys are visible;
 * else the most-recently-active session; else creates one. */
export async function resolveSession(): Promise<string | null> {
  const clients = await tmux(["list-clients", "-F", "#{client_activity}\t#{session_name}"]);
  if (clients.ok) {
    const attached = pickAttachedSession(clients.out);
    if (attached) return attached;
  }
  const ls = await tmux(["list-sessions", "-F", "#{session_activity} #{session_name}"]);
  if (ls.ok && ls.out) {
    let best: { activity: number; name: string } | null = null;
    for (const line of ls.out.split("\n")) {
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      const activity = Number(line.slice(0, sp));
      const name = line.slice(sp + 1);
      if (!name || Number.isNaN(activity)) continue;
      if (!best || activity > best.activity) best = { activity, name };
    }
    if (best) return best.name;
  }
  const created = await tmux(["new-session", "-d", "-P", "-F", "#{session_name}"]);
  return created.ok ? created.out.trim() : null;
}

/** Name of the per-session window that tiles deployed troops. */
export const AGENTS_WINDOW = "agents";

/** window_id of a session's "agents" tiling window, or null if not created yet. */
async function findAgentsWindow(session: string): Promise<string | null> {
  const r = await tmux(["list-windows", "-t", session, "-F", "#{window_id}\t#{window_name}"]);
  if (!r.ok) return null;
  for (const line of r.out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    if (line.slice(tab + 1) === AGENTS_WINDOW) return line.slice(0, tab);
  }
  return null;
}

/** Pick split orientation from the active pane's dimensions, given its
 * width/height in cells. Cells are ~2x taller than wide, so a pane is visually
 * "wide" when cols > 2·rows → split left/right (`-h`); otherwise top/bottom
 * (`-v`). Splitting the longer axis each time tiles like a fibonacci spiral. */
export function splitDir(cols: number, rows: number): "-h" | "-v" {
  return cols > 0 && rows > 0 && cols > 2 * rows ? "-h" : "-v";
}

/** Orientation for the next split of a window's active pane. */
async function splitDirection(target: string): Promise<"-h" | "-v"> {
  const r = await tmux(["display-message", "-p", "-t", target, "#{pane_width} #{pane_height}"]);
  const [w, h] = r.out.trim().split(/\s+/).map(Number);
  return splitDir(w ?? 0, h ?? 0);
}

/** Execute a spawn plan. Returns ids or an error; never throws. */
export async function spawn(plan: SpawnPlan): Promise<SpawnResult> {
  // Defense: the reporter is the only side that knows the host filesystem, so
  // validate a provided cwd here — turns a silent tmux-create failure into a
  // fast, clear rejection (never throws; a stat throw counts as invalid).
  if (plan.cwd) {
    try {
      if (!statSync(plan.cwd).isDirectory()) {
        return { ok: false, error: "cwd not a directory: " + plan.cwd };
      }
    } catch {
      return { ok: false, error: "cwd not a directory: " + plan.cwd };
    }
  }
  const session = await resolveSession();
  if (!session) return { ok: false, error: "no tmux session" };
  const env = { MC_TEMPLATE_ID: plan.templateId };
  // Where the troop lands:
  //  - explicit windowId → split that window's active pane,
  //  - else → a per-session "agents" window: the first troop fills it; each
  //    later troop splits the active pane along its longer axis, so panes tile
  //    like a fibonacci spiral.
  const splitTarget = plan.windowId ?? (await findAgentsWindow(session));
  const create = splitTarget
    ? await tmux(splitWindowArgs(splitTarget, plan.cwd, env, await splitDirection(splitTarget)))
    : await tmux(newWindowArgs(session, AGENTS_WINDOW, plan.cwd, env));
  if (!create.ok) return { ok: false, error: "tmux create failed: " + create.err };
  const [windowId, paneId] = create.out.split(/\s+/);
  if (!paneId) return { ok: false, error: "no pane id" };
  // pane tty → lineage key (procscan tags the agent by tty; env isn't readable on macOS)
  const ttyRes = await tmux(["display-message", "-p", "-t", paneId, "#{pane_tty}"]);
  const tty = ttyRes.ok && ttyRes.out ? normalizeTty(ttyRes.out) : undefined;
  const line = [plan.cmd, ...plan.args].map(shellQuote).join(" ");
  await tmux(launchKeysArgs(paneId, line));
  await tmux(enterKeysArgs(paneId));
  if (plan.prompt) {
    await Bun.sleep(PROMPT_READY_MS); // let the agent TUI's input box come up
    await tmux(launchKeysArgs(paneId, plan.prompt));
    await tmux(enterKeysArgs(paneId));
  }
  // Make the deployed agent visible: switch the attached terminal to its window,
  // or open a terminal tab attached to the session. Best-effort — a headless
  // spawn (no terminal automation) still succeeded.
  try { await revealTmux(session, windowId, paneId); } catch { /* visibility is best-effort */ }
  return { ok: true, windowId, paneId, tty };
}
