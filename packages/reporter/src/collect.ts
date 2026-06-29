import { estimateCost, contextWindowFor, resolveCategory, type HostReport, type Session } from "@mc/shared";
import { matchProvider } from "./providers/index.ts";
import { inspectProc, templateIdOf, type ProcInfo, type ProcInspection } from "./procscan.ts";
import type { ReporterConfig } from "./config.ts";
import type { Summarizer } from "./summarizer.ts";

/** Override the process inspector / clock / summarizer / focus probe in tests. */
export type Deps = {
  inspect: (pid: number) => Promise<ProcInspection>;
  now: () => number;
  summarizer?: Summarizer;
  focusedTtys?: () => Promise<Set<string>>;
  /** Lineage: map a process to the template that spawned it. Resolves by
   * pane tty (works on macOS, unlike env) with an env fallback for Linux. */
  templateId?: (proc: ProcInfo) => Promise<string | null> | string | null;
};

const defaultDeps: Deps = {
  inspect: inspectProc,
  now: () => Date.now(),
  templateId: (p) => templateIdOf(p.pid),
};

/** Turn a process list into a HostReport for this host. */
export async function collect(
  procs: ProcInfo[],
  cfg: ReporterConfig,
  deps: Deps = defaultDeps,
): Promise<HostReport> {
  const now = deps.now();
  const focused = deps.focusedTtys ? await deps.focusedTtys() : new Set<string>();
  const sessions: Session[] = [];

  for (const p of procs) {
    const plugin = matchProvider(p);
    if (!plugin) continue;

    const { cwd, openFiles } = await deps.inspect(p.pid);
    const startedAt = now - p.uptimeSec * 1000;

    let enrichment: Awaited<ReturnType<NonNullable<typeof plugin.enrich>>> = {};
    if (plugin.enrich) {
      try {
        enrichment = await plugin.enrich(p, cwd, {
          home: cfg.home,
          startedAt,
          openFiles,
          now,
          activeTtlMs: cfg.activeTtlMs,
        });
      } catch {
        enrichment = {}; // never let one bad file kill the report
      }
    }
    const { summaryInput, subjectInput, ...enr } = enrichment;

    const id = `${cfg.hostId}:${p.pid}`;
    const session: Session = {
      id,
      provider: plugin.id,
      pid: p.pid,
      hostId: cfg.hostId,
      hostLabel: cfg.hostLabel,
      cwd,
      category: resolveCategory(plugin.id, cwd, plugin.defaultCategory, cfg.categories),
      startedAt,
      cpu: p.cpu,
      memMb: p.memMb,
      ...enr,
    };
    if (p.tty && focused.has(p.tty)) session.focused = true;

    // Best-effort lineage: stamp MC_TEMPLATE_ID read off the process env.
    const tid = deps.templateId ? await deps.templateId(p) : null;
    if (tid) session.templateId = tid;

    // LLM (Haiku) subject + recap + follow-up-question detection (one call).
    if (deps.summarizer?.active && summaryInput) {
      const { subject, summary, awaitingUser, ask, suggestion, fresh } = deps.summarizer.analyze(
        id,
        summaryInput,
        subjectInput,
      );
      if (subject) session.subject = subject; // broad, stable; may be stale (cosmetic)
      if (summary) session.summary = summary; // recap may be stale — that's fine, it's cosmetic
      // Action flag must reflect the CURRENT transcript: only honor when fresh, so a
      // stale "awaiting" from a prior question-turn can't linger after the agent moves on.
      if (awaitingUser && fresh && !session.errored && session.active !== true) {
        session.attention = true;
        if (ask) session.ask = ask; // what the agent is waiting for
        if (suggestion) session.suggestion = suggestion; // a plausible reply to send
      }
    }
    // Prefer a provider-reported cost (pi/hermes track their own); else estimate.
    session.costUsd =
      session.costUsd ??
      estimateCost(
        session.model,
        session.tokensIn,
        session.tokensOut,
        session.tokensCacheRead,
        session.tokensCacheWrite,
      );
    // Provider-reported window wins (codex); else infer from the model.
    session.contextWindow = session.contextWindow ?? contextWindowFor(session.model);
    sessions.push(session);
  }

  return { hostId: cfg.hostId, hostLabel: cfg.hostLabel, sentAt: now, sessions };
}
