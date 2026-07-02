import { test, expect, describe } from "bun:test";
import { Store } from "../store.ts";
import { runBackfill, runSubSessionsBackfill } from "./index.ts";
import type { BackfillAdapter } from "./types.ts";

function fakeAdapter(over: Partial<BackfillAdapter> = {}): BackfillAdapter {
  return {
    id: "fake",
    available: () => true,
    discover: function* () { yield { key: "A", ok: true }; yield { key: "B", ok: false }; },
    sessionKey: (r: any) => r.key,
    toImport: (r: any) => {
      if (!r.ok) throw new Error("bad session");
      return { session: { sessionKey: r.key, liveId: r.key, provider: "fake", hostId: "h",
        hostLabel: "H", cwd: null, category: "x", startedAt: 1, state: "closed", lastSeenAt: 1 } as any };
    },
    ...over,
  } as BackfillAdapter;
}

describe("runBackfill core", () => {
  test("imports good sessions, isolates a throwing session", async () => {
    const s = new Store(":memory:");
    const rep = await runBackfill(s, { registry: [fakeAdapter()], enrich: false } as any);
    expect(rep.providers.fake.imported).toBe(1);
    expect(rep.providers.fake.skipped).toBe(1);
    expect(s.has("A")).toBe(true);
    expect(s.has("B")).toBe(false);
    s.close();
  });
  test("a provider whose discover throws is isolated; others continue", async () => {
    const s = new Store(":memory:");
    const boom = fakeAdapter({ id: "boom", discover: function* () { throw new Error("provider down"); } });
    const rep = await runBackfill(s, { registry: [boom, fakeAdapter()], enrich: false } as any);
    expect(rep.providers.boom.failed).toBe(true);
    expect(rep.providers.fake.imported).toBe(1);
    s.close();
  });
  test("skip-if-exists: re-run imports nothing new", async () => {
    const s = new Store(":memory:");
    await runBackfill(s, { registry: [fakeAdapter()], enrich: false } as any);
    const rep2 = await runBackfill(s, { registry: [fakeAdapter()], enrich: false } as any);
    expect(rep2.providers.fake.imported).toBe(0);
    expect(rep2.providers.fake.skipped).toBe(2);
    s.close();
  });
  test("unavailable adapter is skipped silently", async () => {
    const s = new Store(":memory:");
    const rep = await runBackfill(s, { registry: [fakeAdapter({ available: () => false })], enrich: false } as any);
    expect(rep.providers.fake?.imported ?? 0).toBe(0);
    s.close();
  });
  test("providers filter limits which adapters run", async () => {
    const s = new Store(":memory:");
    const rep = await runBackfill(s, { registry: [fakeAdapter({ id: "a" }), fakeAdapter({ id: "b" })],
      providers: ["a"], enrich: false } as any);
    expect(rep.providers.a.imported).toBe(1);
    expect(rep.providers.b).toBeUndefined();
    s.close();
  });
  test("dryRun parses + tallies but writes nothing", async () => {
    const s = new Store(":memory:");
    const rep = await runBackfill(s, { registry: [fakeAdapter()], enrich: false, dryRun: true } as any);
    expect(rep.providers.fake.imported).toBe(1); // counted as would-import
    expect(s.has("A")).toBe(false);              // but not written
    s.close();
  });
});

describe("sub_sessions backfill phase", () => {
  // adapter yielding one session "A" with a two-subagent breakdown.
  const subAdapter = (over: Partial<BackfillAdapter> = {}) =>
    fakeAdapter({
      discover: function* () { yield { key: "A", ok: true }; },
      subSessions: () => [
        { agentId: "s1", kind: "Explore", tokensIn: 10, costUsd: 0.2, status: "finished" },
        { agentId: "s2", kind: "general-purpose", tokensIn: 20, status: "crashed" },
      ],
      ...over,
    });

  test("populates sub_sessions for imported sessions", async () => {
    const s = new Store(":memory:");
    const rep = await runBackfill(s, { registry: [subAdapter()], enrich: false } as any);
    expect(rep.subSessions).toEqual({ sessions: 1, rows: 2 });
    const got = s.getSubagents("A");
    expect(got.map((g) => g.agentId).sort()).toEqual(["s1", "s2"]);
    expect(got.find((g) => g.agentId === "s2")!.status).toBe("crashed");
    s.close();
  });

  test("idempotent: a second run adds nothing (skip-if-has)", async () => {
    const s = new Store(":memory:");
    await runBackfill(s, { registry: [subAdapter()], enrich: false } as any);
    const rep2 = await runBackfill(s, { registry: [subAdapter()], enrich: false } as any);
    expect(rep2.subSessions).toEqual({ sessions: 0, rows: 0 });
    s.close();
  });

  test("populates a pre-existing (live-reported) session lacking a breakdown", () => {
    const s = new Store(":memory:");
    // Seed a live-reported session with NO subSessions (as an old-code server would).
    s.record({ hostId: "h", hostLabel: "H", sentAt: 1,
      sessions: [{ id: "h:1", provider: "claude", pid: 1, hostId: "h", hostLabel: "H",
        cwd: "/r", category: "code", startedAt: 1, cpu: 0, memMb: 0, providerSessionId: "A" }] } as any, 1);
    s.record({ hostId: "h", hostLabel: "H", sentAt: 2, sessions: [] } as any, 2); // close it
    expect(s.hasSubSessions("A")).toBe(false);
    const out = runSubSessionsBackfill(s, [subAdapter()], {});
    expect(out).toEqual({ sessions: 1, rows: 2 });
    expect(s.getSubagents("A").length).toBe(2);
    s.close();
  });

  test("skips a running session (live reporter owns its status)", () => {
    const s = new Store(":memory:");
    s.record({ hostId: "h", hostLabel: "H", sentAt: 1,
      sessions: [{ id: "h:1", provider: "claude", pid: 1, hostId: "h", hostLabel: "H",
        cwd: "/r", category: "code", startedAt: 1, cpu: 0, memMb: 0, providerSessionId: "A" }] } as any, 1);
    // still running (never closed)
    const out = runSubSessionsBackfill(s, [subAdapter()], {});
    expect(out).toEqual({ sessions: 0, rows: 0 });
    expect(s.hasSubSessions("A")).toBe(false);
    s.close();
  });

  test("skips sessions not in the store", () => {
    const s = new Store(":memory:");
    const out = runSubSessionsBackfill(s, [subAdapter()], {});
    expect(out).toEqual({ sessions: 0, rows: 0 });
    s.close();
  });

  test("dryRun writes no sub_sessions", async () => {
    const s = new Store(":memory:");
    const rep = await runBackfill(s, { registry: [subAdapter()], enrich: false, dryRun: true } as any);
    expect(rep.subSessions).toBeUndefined();
    expect(s.has("A")).toBe(false);
    s.close();
  });
});

describe("runBackfill enrichment phase (BF10)", () => {
  // adapter that yields one good session "A" and exposes a tail for it
  const enrichAdapter = (over: Partial<BackfillAdapter> = {}) =>
    fakeAdapter({
      discover: function* () { yield { key: "A", ok: true }; },
      enrichInput: (r: any) => `tail-for-${r.key}`,
      ...over,
    });
  // a fake batch analyzer that summarizes each item by id
  const fakeAnalyze = async (items: any[]) =>
    items.map((it) => ({ id: it.id, summary: `recap-${it.id}`, awaitingUser: false }));

  test("phase 2 runs after import; rows get enriched", async () => {
    const s = new Store(":memory:");
    const rep = await runBackfill(s, { registry: [enrichAdapter()], analyze: fakeAnalyze } as any);
    expect(rep.providers.fake.imported).toBe(1);
    expect(rep.enrich).toBeDefined();
    expect(rep.enrich!.enriched).toBe(1);
    expect(s.getSession("A")!.session.summary).toBe("recap-A");
    s.close();
  });

  test("dryRun skips enrichment (no writes)", async () => {
    const s = new Store(":memory:");
    const rep = await runBackfill(s, { registry: [enrichAdapter()], analyze: fakeAnalyze, dryRun: true } as any);
    expect(rep.enrich).toBeUndefined();
    expect(s.has("A")).toBe(false);
    s.close();
  });

  test("enrichOnly skips import but still enriches existing null-summary rows", async () => {
    const s = new Store(":memory:");
    // pre-seed an imported row with NULL summary (as a prior import would have left it)
    s.importSession({ sessionKey: "A", liveId: "A", provider: "fake", hostId: "h", hostLabel: "H",
      cwd: null, category: "x", startedAt: 1, state: "closed", lastSeenAt: 1 } as any, [], []);
    expect(s.getSession("A")!.session.summary).toBeUndefined();
    const rep = await runBackfill(s, { registry: [enrichAdapter()], analyze: fakeAnalyze, enrichOnly: true } as any);
    // import write skipped: not counted as imported
    expect(rep.providers.fake.imported).toBe(0);
    // but the existing null-summary row was enriched
    expect(rep.enrich!.enriched).toBe(1);
    expect(s.getSession("A")!.session.summary).toBe("recap-A");
    s.close();
  });

  test("no analyze + no key -> phase skipped", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const s = new Store(":memory:");
      const rep = await runBackfill(s, { registry: [enrichAdapter()] } as any);
      expect(rep.enrich!.skippedPhase).toBe(true);
      expect(rep.enrich!.enriched).toBe(0);
      s.close();
    } finally {
      if (prev != null) process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("enrich:false disables the phase entirely", async () => {
    const s = new Store(":memory:");
    const rep = await runBackfill(s, { registry: [enrichAdapter()], analyze: fakeAnalyze, enrich: false } as any);
    expect(rep.enrich).toBeUndefined();
    s.close();
  });

  test("a throwing enrichInput never sinks the run", async () => {
    const s = new Store(":memory:");
    const rep = await runBackfill(s, {
      registry: [enrichAdapter({ enrichInput: () => { throw new Error("bad tail"); } })],
      analyze: fakeAnalyze,
    } as any);
    expect(rep.providers.fake.imported).toBe(1); // import still happened
    // no tail -> degraded in the enrich phase, not enriched
    expect(rep.enrich!.enriched).toBe(0);
    s.close();
  });
});
