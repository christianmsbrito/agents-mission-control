import { test, expect } from "bun:test";
import { parseClaudeTranscript } from "./claude.ts";

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
