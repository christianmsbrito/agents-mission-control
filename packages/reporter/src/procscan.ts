/** One running process, parsed from `ps`. */
export type ProcInfo = {
  pid: number;
  ppid: number;
  /** seconds since start (parsed from etime). */
  uptimeSec: number;
  cpu: number;
  /** resident memory MB. */
  memMb: number;
  /** short command name (comm). */
  comm: string;
  /** full argv string (args). */
  args: string;
  /** controlling tty, e.g. "ttys001" (or undefined when none). */
  tty?: string;
};

const PS_ARGS = ["-axo", "pid=,ppid=,etime=,pcpu=,rss=,tty=,comm=,args="];

/** Parse `ps` etime (e.g. "01:02:03", "5-01:02:03", "02:03") into seconds. */
export function parseEtime(etime: string): number {
  let days = 0;
  let rest = etime.trim();
  const dash = rest.indexOf("-");
  if (dash !== -1) {
    days = parseInt(rest.slice(0, dash), 10) || 0;
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(":").map((p) => parseInt(p, 10) || 0);
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) [h, m, s] = parts as [number, number, number];
  else if (parts.length === 2) [m, s] = parts as [number, number];
  else if (parts.length === 1) [s] = parts as [number];
  return days * 86400 + h * 3600 + m * 60 + s;
}

/** Parse raw `ps` stdout into ProcInfo rows. Pure — easy to test. */
export function parsePs(stdout: string): ProcInfo[] {
  const rows: ProcInfo[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    // pid ppid etime pcpu rss tty comm args...  (args may contain spaces)
    const m = t.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: parseInt(m[1]!, 10),
      ppid: parseInt(m[2]!, 10),
      uptimeSec: parseEtime(m[3]!),
      cpu: parseFloat(m[4]!) || 0,
      memMb: Math.round((parseInt(m[5]!, 10) || 0) / 1024),
      tty: /^ttys\d+$/.test(m[6]!) ? m[6]! : undefined,
      comm: m[7]!,
      args: m[8]!,
    });
  }
  return rows;
}

/** Run `ps` for real and parse it. */
export async function scanProcesses(): Promise<ProcInfo[]> {
  const proc = Bun.spawn(["ps", ...PS_ARGS], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return parsePs(out);
}

export type ProcInspection = { cwd: string | null; openFiles: string[] };

/** Parse `lsof -F ftn` output into cwd + open regular-file paths. Pure. */
export function parseLsof(out: string): ProcInspection {
  let cwd: string | null = null;
  const openFiles: string[] = [];
  let fd = "";
  let type = "";
  for (const line of out.split("\n")) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "f") {
      fd = val;
      type = "";
    } else if (tag === "t") {
      type = val;
    } else if (tag === "n") {
      if (fd === "cwd") cwd = val;
      else if (type === "REG") openFiles.push(val);
    }
  }
  return { cwd, openFiles };
}

/** cwd + open files for a pid in one `lsof` pass. Returns empties on failure. */
export async function inspectProc(pid: number): Promise<ProcInspection> {
  try {
    const proc = Bun.spawn(["lsof", "-p", String(pid), "-Fftn"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return parseLsof(out);
  } catch {
    return { cwd: null, openFiles: [] };
  }
}

// An agent's cwd is fixed for its lifetime, so one `lsof` per pid is enough.
const cwdCache = new Map<number, string | null>();

/** Cached cwd-only inspect (`openFiles` empty). A failed lookup is retried next tick. */
export async function inspectCwdCached(pid: number): Promise<ProcInspection> {
  if (cwdCache.has(pid)) return { cwd: cwdCache.get(pid)!, openFiles: [] };
  const { cwd } = await inspectProc(pid);
  if (cwd) cwdCache.set(pid, cwd);
  return { cwd, openFiles: [] };
}

/** Drop cwd entries for pids no longer present (pid reuse + bounded memory). */
export function pruneCwdCache(livePids: Set<number>): void {
  for (const pid of cwdCache.keys()) if (!livePids.has(pid)) cwdCache.delete(pid);
}

/** Back-compat: cwd only. */
export async function cwdOf(pid: number): Promise<string | null> {
  return (await inspectProc(pid)).cwd;
}

/** Extract MC_TEMPLATE_ID from a process env blob (space- or NUL-separated). Pure. */
export function parseTemplateIdFromEnv(blob: string): string | null {
  const m = blob.match(/(?:^|[\s\0])MC_TEMPLATE_ID=([^\s\0]+)/);
  return m ? m[1]! : null;
}

// MC_TEMPLATE_ID is immutable for a pid — cache to avoid re-spawning `ps eww` every tick.
const templateIdCache = new Map<number, string | null>();

/** Drop cache entries for pids no longer present (bounds memory + avoids pid-reuse staleness). */
export function pruneTemplateIdCache(livePids: Set<number>): void {
  for (const pid of templateIdCache.keys()) if (!livePids.has(pid)) templateIdCache.delete(pid);
}

/** Best-effort, cached read of a pid's MC_TEMPLATE_ID. Never throws. */
export async function templateIdOf(pid: number): Promise<string | null> {
  if (templateIdCache.has(pid)) return templateIdCache.get(pid)!;
  let result: string | null = null;
  try {
    if (process.platform === "linux") {
      const txt = await Bun.file(`/proc/${pid}/environ`).text();
      result = parseTemplateIdFromEnv(txt);
    } else {
      const p = Bun.spawn(["ps", "eww", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      await p.exited;
      result = parseTemplateIdFromEnv(out);
    }
  } catch {
    result = null;
  }
  templateIdCache.set(pid, result);
  return result;
}
