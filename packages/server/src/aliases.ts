import type { AgentAlias, HostReport, Session } from "@mc/shared";

export type DisplayNameGenerator = (session: Session) => Promise<string | undefined>;

export function sessionGeneration(s: Pick<Session, "hostId" | "pid" | "startedAt">): string {
  return `${s.hostId}:${s.pid}:${s.startedAt}`;
}

type AliasRecord = AgentAlias & { live: boolean };

function handleNumber(handle: string): number {
  return Number(handle.match(/^mc:a(\d+)$/)?.[1] ?? 0);
}

function hasNameContext(s: Session): boolean {
  return Boolean(s.subject?.trim() || s.summary?.trim() || s.cwd?.trim());
}

/**
 * Assigns stable live handles to sessions. The user-facing handle is sticky for
 * the live process locator (`hostId:pid`); `generation` remains metadata so a
 * caller can still tell when the process start time changed.
 */
export class AgentAliasRegistry {
  private next = 1;
  private bySessionId = new Map<string, AliasRecord>();
  private liveByHandle = new Map<string, string>();
  private pendingNames = new Set<string>();

  constructor(private generateDisplayName?: DisplayNameGenerator) {}

  decorate(report: HostReport): HostReport {
    return { ...report, sessions: report.sessions.map((s) => this.decorateSession(s)) };
  }

  setLiveReports(reports: HostReport[]): void {
    const liveSessionIds = new Set<string>();
    this.liveByHandle.clear();

    for (const report of reports) {
      for (const session of report.sessions) {
        const rec = this.bySessionId.get(session.id);
        if (!rec) continue;
        liveSessionIds.add(session.id);
        this.liveByHandle.set(rec.handle, session.id);
      }
    }

    for (const [sessionId, rec] of this.bySessionId) rec.live = liveSessionIds.has(sessionId);
  }

  aliases(): AgentAlias[] {
    return [...this.bySessionId.values()]
      .filter((r) => r.live)
      .sort((a, b) => handleNumber(a.handle) - handleNumber(b.handle))
      .map(({ live: _live, ...alias }) => alias);
  }

  resolve(handle: string): AgentAlias | undefined {
    const sessionId = this.liveByHandle.get(handle);
    const rec = sessionId ? this.bySessionId.get(sessionId) : undefined;
    if (!rec?.live) return undefined;
    const { live: _live, ...alias } = rec;
    return alias;
  }

  private decorateSession(session: Session): Session {
    const generation = sessionGeneration(session);
    let rec = this.bySessionId.get(session.id);
    if (!rec) {
      rec = {
        handle: `mc:a${this.next++}`,
        sessionId: session.id,
        generation,
        provider: session.provider,
        hostId: session.hostId,
        hostLabel: session.hostLabel,
        pid: session.pid,
        startedAt: session.startedAt,
        cwd: session.cwd,
        live: true,
      };
      this.bySessionId.set(session.id, rec);
    }

    rec.sessionId = session.id;
    rec.generation = generation;
    rec.provider = session.provider;
    rec.providerSessionId = session.providerSessionId;
    rec.hostId = session.hostId;
    rec.hostLabel = session.hostLabel;
    rec.pid = session.pid;
    rec.startedAt = session.startedAt;
    rec.cwd = session.cwd;
    rec.subject = session.subject;
    rec.summary = session.summary;
    rec.live = true;

    this.maybeGenerateDisplayName(session.id, rec, session);
    return { ...session, handle: rec.handle, displayName: rec.displayName };
  }

  private maybeGenerateDisplayName(sessionId: string, rec: AliasRecord, session: Session): void {
    if (!this.generateDisplayName || rec.displayName || this.pendingNames.has(sessionId) || !hasNameContext(session)) {
      return;
    }

    this.pendingNames.add(sessionId);
    this.generateDisplayName(session)
      .then((name) => {
        if (name) rec.displayName = name;
      })
      .catch(() => {
        /* display names are cosmetic */
      })
      .finally(() => this.pendingNames.delete(sessionId));
  }
}
