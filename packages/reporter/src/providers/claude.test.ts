import { test, expect } from "bun:test";
import {
  parseClaudeTranscript,
  sumSubagentUsage,
  addSubagentUsage,
  type SubagentEntry,
  type SubagentUsage,
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
