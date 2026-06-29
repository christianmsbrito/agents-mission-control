import type { ReporterMsg, ServerToReporterMsg } from "@mc/shared";
import { loadConfig } from "./config.ts";
import { scanProcesses, inspectProc, templateIdOf, pruneTemplateIdCache, type ProcInfo } from "./procscan.ts";
import { collect, type Deps } from "./collect.ts";
import { Summarizer, anthropicGenerator } from "./summarizer.ts";
import { focusPid, sendText, focusedTtys } from "./focus.ts";
import { killPid } from "./kill.ts";
import { spawn as tmuxSpawn, listWindows } from "./tmux.ts";
import { spawnIterm, listItermTabs } from "./iterm.ts";

const cfg = await loadConfig();
console.log(`[reporter] host=${cfg.hostLabel} -> ${cfg.serverUrl} every ${cfg.intervalMs}ms`);

const generator = cfg.summaries.enabled ? anthropicGenerator(cfg.summaries.model) : null;
const summarizer = new Summarizer(generator, { minIntervalMs: cfg.summaries.minIntervalMs });

// Lineage: pane tty → template id of the template that spawned it. Populated when a
// deploy succeeds (the spawn returns the new pane's tty), read back by tty since
// macOS won't expose MC_TEMPLATE_ID via `ps`. Pruned each tick against live ttys.
const templateByTty = new Map<string, string>();
const resolveTemplate = (p: ProcInfo): Promise<string | null> | string | null => {
  if (p.tty) {
    const t = templateByTty.get(p.tty);
    if (t) return t;
  }
  return templateIdOf(p.pid); // env fallback (Linux /proc)
};
const deps: Deps = { inspect: inspectProc, now: () => Date.now(), summarizer, focusedTtys, templateId: resolveTemplate };
console.log(
  summarizer.active
    ? `[reporter] LLM recaps on (${cfg.summaries.model})`
    : `[reporter] LLM recaps off (no ANTHROPIC_API_KEY or disabled) — using heuristic summaries`,
);

let ws: WebSocket | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let knownPids = new Set<number>(); // agent pids from the last scan — only these may be killed

function send(msg: ReporterMsg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function tick() {
  try {
    const procs = await scanProcesses();
    const report = await collect(procs, cfg, deps);
    knownPids = new Set(report.sessions.map((s) => s.pid));
    pruneTemplateIdCache(knownPids);
    // drop tty→template entries whose tty no longer has a live process (tty reuse)
    const liveTtys = new Set(procs.map((p) => p.tty).filter(Boolean) as string[]);
    for (const tty of templateByTty.keys()) if (!liveTtys.has(tty)) templateByTty.delete(tty);
    report.tmuxWindows = await listWindows(); // best-effort; [] when tmux isn't running
    report.itermTabs = await listItermTabs(); // best-effort; [] off-darwin / iTerm down
    send({ type: "report", report });
  } catch (err) {
    console.error("[reporter] tick error:", err);
  }
}

function connect() {
  ws = new WebSocket(cfg.serverUrl);

  ws.onopen = () => {
    console.log("[reporter] connected");
    send({ type: "hello", hostId: cfg.hostId, hostLabel: cfg.hostLabel, token: cfg.token });
    void tick();
    timer = setInterval(tick, cfg.intervalMs);
  };

  ws.onmessage = (e) => {
    let msg: ServerToReporterMsg;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.type === "focus") {
      void focusPid(msg.pid).then((ok) =>
        console.log(`[reporter] focus pid=${msg.pid} -> ${ok ? "ok" : "not found"}`),
      );
    } else if (msg.type === "kill") {
      const ok = killPid(msg.pid, knownPids);
      console.log(`[reporter] kill pid=${msg.pid} -> ${ok ? "SIGTERM sent" : "refused/failed"}`);
      send({ type: "killed", pid: msg.pid, ok });
    } else if (msg.type === "prompt") {
      if (!knownPids.has(msg.pid)) {
        send({ type: "prompted", pid: msg.pid, ok: false, commandId: msg.commandId }); // only prompt tracked agents
        return;
      }
      void sendText(msg.pid, msg.text).then((ok) => {
        console.log(`[reporter] prompt pid=${msg.pid} -> ${ok ? "sent" : "failed (terminal?)"}`);
        send({ type: "prompted", pid: msg.pid, ok, commandId: msg.commandId });
      });
    } else if (msg.type === "spawn") {
      const plan = {
        cmd: msg.cmd, args: msg.args, prompt: msg.prompt, cwd: msg.cwd,
        templateId: msg.templateId, name: msg.name ?? msg.templateId, windowId: msg.windowId,
      };
      // iterm2 = native panes (macOS); tmux = persistent/headless. iterm2 falls
      // back to tmux off-darwin so a remote host can still honor the deploy.
      const useIterm = (msg.backend ?? "iterm2") === "iterm2" && process.platform === "darwin";
      void (useIterm ? spawnIterm(plan) : tmuxSpawn(plan)).then((r) => {
        console.log(`[reporter] spawn template=${msg.templateId} backend=${useIterm ? "iterm2" : "tmux"} -> ${r.ok ? `${r.windowId ?? ""}/${r.paneId} tty=${r.tty ?? "?"}` : "FAILED:" + r.error}`);
        // remember the pane tty so the next scan tags this troop to its template
        if (r.ok && r.tty) templateByTty.set(r.tty, msg.templateId);
        send({ type: "spawned", ok: r.ok, templateId: msg.templateId, hostId: cfg.hostId,
               windowId: r.windowId, paneId: r.paneId, error: r.error, commandId: msg.commandId });
      });
    } else if (msg.type === "config") {
      cfg.summaries = msg.summaries;
      summarizer.setMinInterval(msg.summaries.minIntervalMs);
      console.log(`[reporter] config: summaries=${msg.summaries.enabled ? "on" : "off"} model=${msg.summaries.model}`);
    }
  };

  ws.onclose = () => {
    console.log("[reporter] disconnected; retrying in 2s");
    if (timer) clearInterval(timer);
    timer = null;
    setTimeout(connect, 2000);
  };

  ws.onerror = () => ws?.close();
}

connect();
