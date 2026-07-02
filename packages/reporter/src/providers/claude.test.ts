import { test, expect } from "bun:test";
import {
  parseClaudeTranscript,
  sumSubagentUsage,
  addSubagentUsage,
  subSessionFromText,
  agentIdFromName,
  buildSubSessions,
  type SubagentEntry,
  type SubagentUsage,
  type SubagentFile,
} from "./claude.ts";
import type { Enrichment } from "./types.ts";

/** Build a one-turn assistant transcript line carrying the given usage. */
function usageLine(id: string, u: Partial<SubagentUsage>): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id,
      role: "assistant",
      model: "claude-opus-4-8",
      usage: {
        input_tokens: u.tokensIn ?? 0,
        output_tokens: u.tokensOut ?? 0,
        cache_read_input_tokens: u.tokensCacheRead ?? 0,
        cache_creation_input_tokens: u.tokensCacheWrite ?? 0,
      },
      content: [],
    },
  });
}

test("sumSubagentUsage: sums the four token counters across subagent transcripts", () => {
  const a = usageLine("a1", { tokensIn: 100, tokensOut: 50, tokensCacheRead: 10, tokensCacheWrite: 2 });
  const b = usageLine("b1", { tokensIn: 200, tokensOut: 25, tokensCacheRead: 5, tokensCacheWrite: 3 });
  const entries: SubagentEntry[] = [
    { key: "f1:1:10", read: () => a },
    { key: "f2:1:10", read: () => b },
  ];
  expect(sumSubagentUsage(entries, new Map())).toEqual({
    tokensIn: 300,
    tokensOut: 75,
    tokensCacheRead: 15,
    tokensCacheWrite: 5,
  });
});

test("sumSubagentUsage: cache hit skips re-reading an unchanged file", () => {
  const text = usageLine("a1", { tokensIn: 10, tokensOut: 5 });
  const cache = new Map<string, SubagentUsage>();
  let reads = 0;
  const entries: SubagentEntry[] = [{ key: "f1:mtimeA:10", read: () => { reads++; return text; } }];
  sumSubagentUsage(entries, cache);
  sumSubagentUsage(entries, cache); // same key => served from cache
  expect(reads).toBe(1);
});

test("sumSubagentUsage: evicts cache keys no longer present (file changed/removed)", () => {
  const text = usageLine("a1", { tokensIn: 10, tokensOut: 5 });
  const cache = new Map<string, SubagentUsage>();
  sumSubagentUsage([{ key: "f1:mtimeA:10", read: () => text }], cache);
  expect(cache.has("f1:mtimeA:10")).toBe(true);
  // A later tick sees the file grown (new mtime:size key): the stale key is dropped.
  sumSubagentUsage([{ key: "f1:mtimeB:20", read: () => text }], cache);
  expect(cache.has("f1:mtimeA:10")).toBe(false);
  expect(cache.has("f1:mtimeB:20")).toBe(true);
});

test("addSubagentUsage: folds token counters but never touches contextTokens/model", () => {
  const base: Enrichment = {
    tokensIn: 1000,
    tokensOut: 500,
    tokensCacheRead: 10,
    tokensCacheWrite: 20,
    contextTokens: 9999,
    model: "claude-opus-4-8",
  };
  addSubagentUsage(base, { tokensIn: 100, tokensOut: 50, tokensCacheRead: 5, tokensCacheWrite: 2 });
  expect(base.tokensIn).toBe(1100);
  expect(base.tokensOut).toBe(550);
  expect(base.tokensCacheRead).toBe(15);
  expect(base.tokensCacheWrite).toBe(22);
  expect(base.contextTokens).toBe(9999); // live-window occupancy is the main session's, not a sum
  expect(base.model).toBe("claude-opus-4-8");
});

test("parseClaudeTranscript: extracts the latest TodoWrite list as workItems", () => {
  const lines = [
    { type: "assistant", message: { id: "m1", role: "assistant", content: [
      { type: "tool_use", name: "TodoWrite", input: { todos: [
        { content: "first", status: "pending", activeForm: "doing first" },
      ] } },
    ] } },
    { type: "assistant", message: { id: "m2", role: "assistant", content: [
      { type: "tool_use", name: "TodoWrite", input: { todos: [
        { content: "first", status: "completed", activeForm: "doing first" },
        { content: "second", status: "in_progress", activeForm: "doing second" },
      ] } },
    ] } },
  ].map((o) => JSON.stringify(o)).join("\n");

  const e = parseClaudeTranscript(lines);
  expect(e.workItems).toBeDefined();
  expect(e.workItems!.length).toBe(2);
  expect(e.workItems![0]).toMatchObject({ subject: "first", status: "completed", position: 0 });
  expect(e.workItems![1]).toMatchObject({ subject: "second", status: "in_progress", position: 1 });
  // itemKey stable & content-derived: same content => same key across the two writes.
  expect(typeof e.workItems![0].itemKey).toBe("string");
  expect(e.workItems![0].itemKey.length).toBeGreaterThan(0);
});

test("parseClaudeTranscript: no TodoWrite => no workItems", () => {
  const lines = JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant",
    content: [{ type: "text", text: "hi" }] } });
  expect(parseClaudeTranscript(lines).workItems).toBeUndefined();
});

test("agentIdFromName: strips agent- prefix and .jsonl suffix to the hash", () => {
  expect(agentIdFromName("agent-a016159e691a716ee.jsonl")).toBe("a016159e691a716ee");
  // No conventional shape => return the name unchanged (never throws).
  expect(agentIdFromName("weird.jsonl")).toBe("weird");
});

test("subSessionFromText: prefers the transcript's agentId over the fallback", () => {
  const line = JSON.stringify({
    type: "assistant",
    agentId: "realId123",
    message: { id: "m1", role: "assistant", model: "claude-opus-4-8",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 },
      content: [] },
    timestamp: "2026-06-24T20:46:32.008Z",
  });
  const s = subSessionFromText(line, "fallbackId");
  expect(s.agentId).toBe("realId123");
});

test("subSessionFromText: falls back to the given agentId when the transcript has none", () => {
  const line = usageLine("m1", { tokensIn: 100, tokensOut: 50 });
  const s = subSessionFromText(line, "fallbackId");
  expect(s.agentId).toBe("fallbackId");
});

test("subSessionFromText: carries tokens, model, peakContext, tools, cost, and time bounds", () => {
  const lines = [
    JSON.stringify({
      type: "assistant",
      message: { id: "m1", role: "assistant", model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 },
        content: [{ type: "tool_use", name: "Read", input: {} }] },
      timestamp: "2026-06-24T20:46:32.008Z",
    }),
    JSON.stringify({
      type: "assistant",
      message: { id: "m2", role: "assistant", model: "claude-opus-4-8",
        usage: { input_tokens: 200, output_tokens: 25, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
        content: [{ type: "tool_use", name: "Grep", input: {} }] },
      timestamp: "2026-06-24T20:47:32.000Z",
    }),
  ].join("\n");
  const s = subSessionFromText(lines, "id", "Explore");
  expect(s.agentId).toBe("id");
  expect(s.kind).toBe("Explore");
  expect(s.tokensIn).toBe(300);
  expect(s.tokensOut).toBe(75);
  expect(s.tokensCacheRead).toBe(15);
  expect(s.tokensCacheWrite).toBe(5);
  expect(s.model).toBe("claude-opus-4-8");
  // peakContextTokens = the parsed contextTokens (last turn's occupancy).
  expect(s.peakContextTokens).toBe(200 + 25 + 5 + 3);
  expect(s.toolsUsed).toEqual(expect.arrayContaining(["Read", "Grep"]));
  expect(s.costUsd).toBeGreaterThan(0);
  expect(s.firstAt).toBe(Date.parse("2026-06-24T20:46:32.008Z"));
  expect(s.lastAt).toBe(Date.parse("2026-06-24T20:47:32.000Z"));
});

test("subSessionFromText: omits kind when none is given", () => {
  const s = subSessionFromText(usageLine("m1", { tokensIn: 1 }), "id");
  expect(s.kind).toBeUndefined();
});

test("buildSubSessions: emits one SubSession per file, keyed by mtime:size, cached", () => {
  const a = usageLine("a1", { tokensIn: 100, tokensOut: 50 });
  const b = usageLine("b1", { tokensIn: 200, tokensOut: 25 });
  let reads = 0;
  const files: SubagentFile[] = [
    { key: "agentA:1:10", agentId: "agentA", kind: "Explore", read: () => { reads++; return a; } },
    { key: "agentB:1:10", agentId: "agentB", read: () => { reads++; return b; } },
  ];
  const cache = new Map();
  const subs = buildSubSessions(files, cache);
  expect(subs.length).toBe(2);
  expect(subs.map((s) => s.agentId).sort()).toEqual(["agentA", "agentB"]);
  expect(subs.find((s) => s.agentId === "agentA")!.kind).toBe("Explore");
  expect(reads).toBe(2);
  // Second call, same keys => served from cache, no re-read.
  buildSubSessions(files, cache);
  expect(reads).toBe(2);
});

test("buildSubSessions: evicts cache keys no longer present this tick", () => {
  const text = usageLine("a1", { tokensIn: 10, tokensOut: 5 });
  const cache = new Map();
  buildSubSessions([{ key: "agentA:1:10", agentId: "agentA", read: () => text }], cache);
  expect(cache.has("agentA:1:10")).toBe(true);
  buildSubSessions([{ key: "agentA:2:20", agentId: "agentA", read: () => text }], cache);
  expect(cache.has("agentA:1:10")).toBe(false);
  expect(cache.has("agentA:2:20")).toBe(true);
});

test("totals invariant: main token totals equal main-only + Σ subSessions", () => {
  // Main session's own usage (before folding).
  const mainOnly: SubagentUsage = { tokensIn: 1000, tokensOut: 500, tokensCacheRead: 10, tokensCacheWrite: 20 };
  const base: Enrichment = { ...mainOnly };
  const files: SubagentFile[] = [
    { key: "a:1:1", agentId: "a", read: () => usageLine("a1", { tokensIn: 100, tokensOut: 50, tokensCacheRead: 5, tokensCacheWrite: 2 }) },
    { key: "b:1:1", agentId: "b", read: () => usageLine("b1", { tokensIn: 200, tokensOut: 25, tokensCacheRead: 3, tokensCacheWrite: 1 }) },
  ];
  const subs = buildSubSessions(files, new Map());
  // Fold the subagent sum into the headline totals (as the real path does).
  const sum = subs.reduce(
    (acc, s) => ({
      tokensIn: acc.tokensIn + (s.tokensIn ?? 0),
      tokensOut: acc.tokensOut + (s.tokensOut ?? 0),
      tokensCacheRead: acc.tokensCacheRead + (s.tokensCacheRead ?? 0),
      tokensCacheWrite: acc.tokensCacheWrite + (s.tokensCacheWrite ?? 0),
    }),
    { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 },
  );
  addSubagentUsage(base, sum);
  // headline total === main-only + Σ subSessions
  expect(base.tokensIn).toBe(mainOnly.tokensIn + sum.tokensIn);
  expect(base.tokensOut).toBe(mainOnly.tokensOut + sum.tokensOut);
  expect(base.tokensCacheRead).toBe(mainOnly.tokensCacheRead + sum.tokensCacheRead);
  expect(base.tokensCacheWrite).toBe(mainOnly.tokensCacheWrite + sum.tokensCacheWrite);
  // and main-only = total − Σ subSessions (the documented reconstruction)
  expect(base.tokensIn - sum.tokensIn).toBe(mainOnly.tokensIn);
});
