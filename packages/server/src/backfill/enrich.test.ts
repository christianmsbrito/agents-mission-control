import { test, expect, describe } from "bun:test";
import { Store } from "../store.ts";
import { enrichMissing, parseAnalyzeResponse, type BatchAnalyze, type EnrichItem, type EnrichResult } from "./enrich.ts";

const mk = (key: string, over: any = {}) => ({
  sessionKey: key, liveId: key, provider: "claude", hostId: "h", hostLabel: "H",
  cwd: "/r", category: "code", startedAt: 1000, state: "closed", lastSeenAt: 2000, ...over,
} as any);

describe("parseAnalyzeResponse", () => {
  test("parses the top-level array form", () => {
    const r = parseAnalyzeResponse(
      JSON.stringify([{ id: "A", subject: "s", summary: "sum", awaiting_user: false, ask: "", suggestion: "" }]),
    );
    expect(r).toEqual([{ id: "A", subject: "s", summary: "sum", awaitingUser: false, ask: undefined, suggestion: undefined }]);
  });

  test("parses the {results:[...]} wrapper form", () => {
    const r = parseAnalyzeResponse(
      JSON.stringify({ results: [{ id: "A", subject: "s", summary: "sum", awaiting_user: false, ask: "", suggestion: "" }] }),
    );
    expect(r.length).toBe(1);
    expect(r[0]!.id).toBe("A");
    expect(r[0]!.summary).toBe("sum");
  });

  test("awaiting_user:true -> awaitingUser:true; whitespace ask/suggestion -> undefined", () => {
    const r = parseAnalyzeResponse(
      JSON.stringify([{ id: "A", subject: "  ", summary: " recap ", awaiting_user: true, ask: "  ", suggestion: "yes, go" }]),
    );
    expect(r[0]!.awaitingUser).toBe(true);
    expect(r[0]!.subject).toBeUndefined();   // whitespace-only
    expect(r[0]!.summary).toBe("recap");     // trimmed
    expect(r[0]!.ask).toBeUndefined();       // whitespace-only
    expect(r[0]!.suggestion).toBe("yes, go");
  });

  test("items with non-string / missing id are skipped", () => {
    const r = parseAnalyzeResponse(
      JSON.stringify([
        { id: 5, summary: "no" },
        { summary: "alsono" },
        { id: "ok", summary: "yes" },
      ]),
    );
    expect(r.map((x) => x.id)).toEqual(["ok"]);
  });

  test("malformed JSON -> [] (no throw)", () => {
    expect(parseAnalyzeResponse("not json{")).toEqual([]);
    expect(parseAnalyzeResponse("")).toEqual([]);
  });

  test("neither array nor results wrapper -> []", () => {
    expect(parseAnalyzeResponse(JSON.stringify({ foo: 1 }))).toEqual([]);
  });
});

describe("enrichMissing", () => {
  test("id-keyed mapping regardless of order (analyze returns reversed)", async () => {
    const s = new Store(":memory:");
    s.importSession(mk("A", { subject: "subA" }), [], []);
    s.importSession(mk("B", { subject: "subB" }), [], []);
    s.importSession(mk("C", { subject: "subC" }), [], []);
    const tails = new Map([["A", "tailA"], ["B", "tailB"], ["C", "tailC"]]);
    const analyze: BatchAnalyze = async (items) =>
      items
        .map((it): EnrichResult => ({ id: it.id, summary: `sum-${it.id}`, awaitingUser: it.id === "B", ask: it.id === "B" ? "ask-B" : undefined }))
        .reverse();
    const r = await enrichMissing(s, { tails, analyze });
    expect(r.enriched).toBe(3);
    expect(r.degraded).toBe(0);
    expect(r.skippedPhase).toBe(false);
    expect(s.getSession("A")!.session.summary).toBe("sum-A");
    expect(s.getSession("B")!.session.summary).toBe("sum-B");
    expect(s.getSession("C")!.session.summary).toBe("sum-C");
    expect(s.getSession("B")!.session.attention).toBe(true);
    expect(s.getSession("B")!.session.ask).toBe("ask-B");
    expect(s.getSession("A")!.session.attention).toBe(false);
    s.close();
  });

  test("misaligned: analyze returns only 2 of 3 -> 3rd stays null, degraded counts it, no throw", async () => {
    const s = new Store(":memory:");
    s.importSession(mk("A"), [], []);
    s.importSession(mk("B"), [], []);
    s.importSession(mk("C"), [], []);
    const tails = new Map([["A", "ta"], ["B", "tb"], ["C", "tc"]]);
    const analyze: BatchAnalyze = async (items) =>
      items.filter((it) => it.id !== "C").map((it): EnrichResult => ({ id: it.id, summary: `s-${it.id}` }));
    const r = await enrichMissing(s, { tails, analyze });
    expect(r.enriched).toBe(2);
    expect(r.degraded).toBe(1);
    expect(s.getSession("C")!.session.summary).toBeUndefined();
    s.close();
  });

  test("batch throws twice -> chunk degraded, no throw", async () => {
    const s = new Store(":memory:");
    s.importSession(mk("A"), [], []);
    s.importSession(mk("B"), [], []);
    const tails = new Map([["A", "ta"], ["B", "tb"]]);
    const analyze: BatchAnalyze = async () => { throw new Error("boom"); };
    const r = await enrichMissing(s, { tails, analyze });
    expect(r.enriched).toBe(0);
    expect(r.degraded).toBe(2);
    expect(s.getSession("A")!.session.summary).toBeUndefined();
    s.close();
  });

  test("batch throws once then succeeds (retry)", async () => {
    const s = new Store(":memory:");
    s.importSession(mk("A"), [], []);
    const tails = new Map([["A", "ta"]]);
    let calls = 0;
    const analyze: BatchAnalyze = async (items) => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return items.map((it): EnrichResult => ({ id: it.id, summary: `s-${it.id}` }));
    };
    const r = await enrichMissing(s, { tails, analyze });
    expect(calls).toBe(2);
    expect(r.enriched).toBe(1);
    expect(s.getSession("A")!.session.summary).toBe("s-A");
    s.close();
  });

  test("no analyze (null) -> skippedPhase true, rows unchanged", async () => {
    const s = new Store(":memory:");
    s.importSession(mk("A"), [], []);
    const r = await enrichMissing(s, { tails: new Map([["A", "ta"]]), analyze: null });
    expect(r.skippedPhase).toBe(true);
    expect(r.enriched).toBe(0);
    expect(s.getSession("A")!.session.summary).toBeUndefined();
    s.close();
  });

  test("a row with no tail -> degraded, not sent to analyze", async () => {
    const s = new Store(":memory:");
    s.importSession(mk("A"), [], []);
    s.importSession(mk("B"), [], []);
    const tails = new Map([["A", "ta"]]); // B has no tail
    const seen: string[] = [];
    const analyze: BatchAnalyze = async (items) => {
      for (const it of items) seen.push(it.id);
      return items.map((it): EnrichResult => ({ id: it.id, summary: `s-${it.id}` }));
    };
    const r = await enrichMissing(s, { tails, analyze });
    expect(seen).toEqual(["A"]);
    expect(r.enriched).toBe(1);
    expect(r.degraded).toBe(1);
    s.close();
  });

  test("already-enriched rows (summary set) are not re-enriched", async () => {
    const s = new Store(":memory:");
    s.importSession(mk("A", { summary: "already" }), [], []);
    const analyze: BatchAnalyze = async (items) =>
      items.map((it): EnrichResult => ({ id: it.id, summary: "fresh" }));
    const r = await enrichMissing(s, { tails: new Map([["A", "ta"]]), analyze });
    expect(r.enriched).toBe(0);
    expect(s.getSession("A")!.session.summary).toBe("already");
    s.close();
  });

  test("chunks by batchSize", async () => {
    const s = new Store(":memory:");
    const tails = new Map<string, string>();
    for (let i = 0; i < 5; i++) { s.importSession(mk(`K${i}`), [], []); tails.set(`K${i}`, `t${i}`); }
    const chunkSizes: number[] = [];
    const analyze: BatchAnalyze = async (items) => {
      chunkSizes.push(items.length);
      return items.map((it): EnrichResult => ({ id: it.id, summary: `s-${it.id}` }));
    };
    const r = await enrichMissing(s, { tails, analyze, batchSize: 2 });
    expect(r.enriched).toBe(5);
    expect(chunkSizes).toEqual([2, 2, 1]);
    s.close();
  });
});
