import { test, expect, describe } from "bun:test";
import { openclawToImport } from "./openclaw.ts";

// One session header line + two usage-bearing assistant turns (one with a
// tool_use) using OpenClaw's NATIVE field shapes: usage.{input,output,cacheRead,
// cacheWrite} + a usage.cost object (not claude's *_tokens names).
const SID = "cb6ae8b1-2e50-4571-babe-266df0d835c9";
const T1 = "2026-04-18T23:48:06.771Z"; // header / start
const T2 = "2026-04-18T23:50:00.000Z"; // turn 1
const T3 = "2026-04-19T00:20:00.000Z"; // turn 2 (next hour)

const HEADER = JSON.stringify({ type: "session", version: 3, id: SID, timestamp: T1, cwd: "/app" });

const MSG1 = JSON.stringify({
  type: "message",
  id: "m1",
  timestamp: T2,
  message: {
    role: "user",
    content: [{ type: "text", text: "build the openclaw adapter" }],
    timestamp: Date.parse(T2),
  },
});

const MSG2 = JSON.stringify({
  type: "message",
  id: "m2",
  timestamp: T2,
  message: {
    role: "assistant",
    model: "claude-opus-4-8",
    content: [
      { type: "text", text: "reading the file" },
      { type: "tool_use", name: "Read", input: {} },
    ],
    timestamp: Date.parse(T2),
    usage: {
      input: 1000,
      output: 300,
      cacheRead: 200,
      cacheWrite: 100,
      totalTokens: 1600,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
    },
  },
});

const MSG3 = JSON.stringify({
  type: "message",
  id: "m3",
  timestamp: T3,
  message: {
    role: "assistant",
    model: "claude-opus-4-8",
    content: [{ type: "tool_use", name: "Edit", input: {} }],
    timestamp: Date.parse(T3),
    usage: {
      input: 500,
      output: 150,
      cacheRead: 50,
      cacheWrite: 0,
      totalTokens: 700,
      cost: { input: 0.005, output: 0.01, cacheRead: 0.0002, cacheWrite: 0, total: 0.0152 },
    },
  },
});

const TEXT = [HEADER, MSG1, MSG2, MSG3].join("\n");
const META = { sessionId: SID, cwd: "/app", mtime: Date.parse("2026-04-19T01:00:00.000Z") };

describe("openclawToImport", () => {
  test("builds a closed openclaw session with native field tokens + tools", () => {
    const { session } = openclawToImport(TEXT, META);

    expect(session.provider).toBe("openclaw");
    expect(session.sessionKey).toBe(SID);
    expect(session.resumeId).toBe(SID); // sessionKey === resumeId === UUID
    expect(session.state).toBe("closed");

    // tokens summed off OpenClaw's native usage.{input,output,cacheRead,cacheWrite}
    expect(session.tokensIn).toBe(1500); // 1000 + 500
    expect(session.tokensOut).toBe(450); // 300 + 150
    expect(session.tokensCacheRead).toBe(250); // 200 + 50
    expect(session.tokensCacheWrite).toBe(100); // 100 + 0

    expect(session.toolsUsed).toContain("Read");
    expect(session.toolsUsed).toContain("Edit");
    expect(session.model).toBe("claude-opus-4-8");

    expect(session.startedAt).toBe(Date.parse(T1)); // header timestamp
    expect(session.endedAt).toBe(Date.parse(T3));
    expect(session.lastSeenAt).toBe(Date.parse(T3));
    expect(session.cwd).toBe("/app");
    expect(session.liveId).toContain(":0");
  });

  test("uses the NATIVE summed cost (not undefined, not estimated)", () => {
    const { session } = openclawToImport(TEXT, META);
    // 0.033 + 0.0152 = 0.0482
    expect(session.costUsd).toBeCloseTo(0.0482, 6);
  });

  test("leaves summary null and sets a heuristic subject (Haiku fills summary in BF10)", () => {
    const { session } = openclawToImport(TEXT, META);
    expect(session.summary).toBeUndefined();
    expect(session.subject).toBeDefined();
    expect(session.subject).toContain("build the openclaw adapter");
  });

  test("peakContextTokens is the MAX turn occupancy, not the last turn's", () => {
    const { session } = openclawToImport(TEXT, META);
    // turn1 occupancy = 1000+300+200+100 = 1600; turn2 (last) = 500+150+50+0 = 700
    expect(session.peakContextTokens).toBe(1600);
  });

  test("emits hour-bucketed cumulative samples (timestamps present)", () => {
    const { samples } = openclawToImport(TEXT, META);
    expect(samples.length).toBeGreaterThanOrEqual(2); // two distinct hours
    for (const s of samples) {
      expect(s.resolution).toBe("hour");
      expect(s.sessionKey).toBe(SID);
      expect(s.at % 3_600_000).toBe(0);
    }
    const last = samples[samples.length - 1];
    expect(last.tokensIn).toBe(1500);
    expect(last.tokensOut).toBe(450);
  });

  test("emits started, tool, and closed events", () => {
    const { events } = openclawToImport(TEXT, META);
    const started = events.find((e) => e.type === "session.started");
    const tool = events.find((e) => e.type === "session.tool");
    const closed = events.find((e) => e.type === "session.closed");

    expect(started).toBeDefined();
    expect(started!.at).toBe(Date.parse(T1));
    expect(started!.sessionKey).toBe(SID);

    expect(tool).toBeDefined();
    expect(typeof (tool!.detail as any)?.tool).toBe("string");

    expect(closed).toBeDefined();
    expect(closed!.at).toBe(Date.parse(T3));
  });

  test("garbage/empty transcript yields a minimal session without throwing", () => {
    const { session, samples, events } = openclawToImport("not json\n\n{bad", {
      sessionId: "empty-1",
      cwd: null,
      mtime: 1234,
    });
    expect(session.sessionKey).toBe("empty-1");
    expect(session.provider).toBe("openclaw");
    expect(session.state).toBe("closed");
    expect(session.startedAt).toBe(1234);
    expect(session.endedAt).toBe(1234);
    expect(samples).toEqual([]);
    // no native cost present -> left undefined (orchestrator estimates).
    expect(session.costUsd).toBeUndefined();
    expect(events.find((e) => e.type === "session.started")).toBeDefined();
    expect(events.find((e) => e.type === "session.closed")).toBeDefined();
  });
});
