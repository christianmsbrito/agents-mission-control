import type { AgentAlias, AppConfig, HostReport, LiveMsg, SerializableCategoryConfig, Session } from "@mc/shared";
import { compileCwdRules, resolveCategory } from "@mc/shared";
import { AgentAliasRegistry } from "./aliases.ts";

/** A browser subscriber. */
export type LiveSink = (msg: LiveMsg) => void;

/**
 * In-memory state of all hosts. Transport-agnostic so it can be unit-tested
 * without real WebSockets.
 */
export class Hub {
  private hosts = new Map<string, HostReport>();
  private lastSeen = new Map<string, number>();
  private sinks = new Set<LiveSink>();

  constructor(
    private staleMs = 10_000,
    private getCategories: () => SerializableCategoryConfig = () => ({}),
    private aliases = new AgentAliasRegistry(),
  ) {}

  setStaleMs(ms: number): void {
    this.staleMs = ms;
  }

  /** Browser connected: register sink, return full state snapshot. */
  subscribe(sink: LiveSink): () => void {
    this.sinks.add(sink);
    sink({ type: "state", hosts: [...this.hosts.values()] });
    return () => this.sinks.delete(sink);
  }

  /** A reporter sent a fresh snapshot. Broadcasts a patch to browsers. */
  ingest(report: HostReport, now: number): void {
    const cats = compileCwdRules(this.getCategories());
    const categorized = {
      ...report,
      sessions: report.sessions.map((s) => ({
        ...s,
        category: resolveCategory(s.provider, s.cwd, s.category, cats),
      })),
    };
    const resolved = this.aliases.decorate(categorized);
    this.hosts.set(report.hostId, resolved);
    this.aliases.setLiveReports(this.snapshot());
    this.lastSeen.set(report.hostId, now);
    this.broadcast({ type: "patch", report: resolved });
  }

  /** Reporter heartbeat without a new snapshot. */
  touch(hostId: string, now: number): void {
    if (this.hosts.has(hostId)) this.lastSeen.set(hostId, now);
  }

  /** Drop hosts not seen within staleMs; emit offline for each. */
  sweep(now: number): void {
    for (const [hostId, seen] of this.lastSeen) {
      if (now - seen > this.staleMs) this.dropHost(hostId);
    }
  }

  /** Explicitly remove a host (e.g. reporter socket closed). */
  dropHost(hostId: string): void {
    if (!this.hosts.has(hostId)) return;
    this.hosts.delete(hostId);
    this.lastSeen.delete(hostId);
    this.aliases.setLiveReports(this.snapshot());
    this.broadcast({ type: "offline", hostId });
  }

  snapshot(): HostReport[] {
    return [...this.hosts.values()];
  }

  listAliases(): AgentAlias[] {
    return this.aliases.aliases();
  }

  findSession(sessionId: string): Session | undefined {
    for (const h of this.snapshot()) {
      const s = h.sessions.find((x) => x.id === sessionId);
      if (s) return s;
    }
    return undefined;
  }

  findSessionByHandle(handle: string): Session | undefined {
    const alias = this.aliases.resolve(handle);
    return alias ? this.findSession(alias.sessionId) : undefined;
  }

  findSessionByProviderSession(provider: string, providerSessionId: string | undefined, cwd?: string | null): Session | undefined {
    for (const h of this.snapshot()) {
      const exact = providerSessionId
        ? h.sessions.find((s) => s.provider === provider && s.providerSessionId === providerSessionId)
        : undefined;
      if (exact) return exact;
    }
    if (!cwd) return undefined;
    const matches: Session[] = [];
    for (const h of this.snapshot()) {
      for (const s of h.sessions) {
        if (s.provider === provider && s.cwd === cwd) matches.push(s);
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  broadcastSettings(config: AppConfig): void {
    this.broadcast({ type: "settings", config });
  }

  private broadcast(msg: LiveMsg): void {
    for (const sink of this.sinks) sink(msg);
  }
}
