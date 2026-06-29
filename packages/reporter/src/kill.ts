/**
 * Terminate an agent process by pid. Guarded: only pids the reporter currently
 * tracks as agent sessions can be killed, so the dashboard can't be used to kill
 * arbitrary system processes. Sends SIGTERM (graceful — lets the agent clean up).
 */
export function killPid(pid: number, knownPids: Set<number>): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (!knownPids.has(pid)) return false; // not a tracked agent — refuse
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false; // already gone / no permission
  }
}
