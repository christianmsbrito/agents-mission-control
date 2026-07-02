import { test, expect, describe } from "bun:test";
import { claudeToImport } from "./claude.ts";
import { parseClaudeTranscript } from "../../../../reporter/src/providers/claude.ts";

// Two usage-bearing assistant turns (with a tool_use) + dedupe by message.id.
const T1 = "2026-06-18T10:00:00.000Z";
const T2 = "2026-06-18T10:30:00.000Z";
const T3 = "2026-06-18T11:15:00.000Z";

const TRANSCRIPT = [
  JSON.stringify({ type: "summary", summary: "Wiring the backfill adapter" }),
  JSON.stringify({
    type: "user",
    timestamp: T1,
    sessionId: "sess-abc",
    cwd: "/tmp/proj",
    message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
  }),
  // streaming partial of msg "m1" — should be superseded by the final below.
  JSON.stringify({
    type: "assistant",
    timestamp: T1,
    message: {
      id: "m1",
      model: "claude-opus-4-8",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
      content: [{ type: "text", text: "partial" }],
    },
  }),
  // final of msg "m1"
  JSON.stringify({
    type: "assistant",
    timestamp: T2,
    message: {
      id: "m1",
      model: "claude-opus-4-8",
      usage: { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 100, output_tokens: 300 },
      content: [
        { type: "text", text: "reading the file" },
        { type: "tool_use", name: "Read", input: {} },
      ],
    },
  }),
  // second assistant turn, distinct id
  JSON.stringify({
    type: "assistant",
    timestamp: T3,
    message: {
      id: "m2",
      model: "claude-opus-4-8",
      usage: { input_tokens: 500, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens: 150 },
      content: [{ type: "tool_use", name: "Edit", input: {} }],
    },
  }),
].join("\n");

const META = { sessionId: "sess-abc", cwd: "/tmp/proj", mtime: Date.parse("2026-06-18T12:00:00.000Z") };

describe("claudeToImport", () => {
  test("builds a closed claude session with summed tokens and tools", () => {
    const enr = parseClaudeTranscript(TRANSCRIPT);
    const { session } = claudeToImport(TRANSCRIPT, META);

    expect(session.provider).toBe("claude");
    expect(session.sessionKey).toBe("sess-abc");
    expect(session.resumeId).toBe("sess-abc");
    expect(session.state).toBe("closed");

    // token rollups line up with parseClaudeTranscript (no duplicate aggregation).
    expect(session.tokensIn).toBe(enr.tokensIn);
    expect(session.tokensOut).toBe(enr.tokensOut);
    expect(session.tokensCacheRead).toBe(enr.tokensCacheRead);
    expect(session.tokensCacheWrite).toBe(enr.tokensCacheWrite);
    // dedupe: m1 final (1000) + m2 (500), partial 1 dropped.
    expect(session.tokensIn).toBe(1500);

    expect(session.toolsUsed).toContain("Read");
    expect(session.toolsUsed).toContain("Edit");
    expect(session.model).toBe("claude-opus-4-8");

    expect(session.startedAt).toBe(Date.parse(T1));
    expect(session.endedAt).toBe(Date.parse(T3));
    expect(session.lastSeenAt).toBe(Date.parse(T3));
  });

  test("leaves summary null and sets a heuristic subject (Haiku fills summary in BF10)", () => {
    const { session } = claudeToImport(TRANSCRIPT, META);
    expect(session.summary).toBeUndefined();
    // subject is the heuristic opening-prompt text, not the transcript summary.
    expect(session.subject).toBeDefined();
    expect(session.subject).toContain("do the thing");
  });

  test("peakContextTokens is the MAX turn occupancy, not the last turn's", () => {
    // m1 occupancy = 1000+200+100+300 = 1600; m2 (the LAST turn) = 500+50+0+150 = 700.
    const enr = parseClaudeTranscript(TRANSCRIPT);
    const { session } = claudeToImport(TRANSCRIPT, META);
    expect(enr.contextTokens).toBe(700); // last-turn occupancy
    expect(session.peakContextTokens).toBe(1600); // the earlier, higher turn
  });

  test("folds subagent transcript tokens into the session rollup", () => {
    // A subagent-driven session: the main transcript is thin, the delegated work
    // (and most of the cost) lives in separate agent-*.jsonl transcripts.
    const sub1 = JSON.stringify({
      type: "assistant",
      timestamp: T2,
      isSidechain: true,
      message: {
        id: "s1",
        model: "claude-opus-4-8",
        usage: { input_tokens: 400, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 200 },
        content: [{ type: "text", text: "subagent work" }],
      },
    });
    const sub2 = JSON.stringify({
      type: "assistant",
      timestamp: T3,
      isSidechain: true,
      message: {
        id: "s2",
        model: "claude-opus-4-8",
        usage: { input_tokens: 600, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 },
        content: [{ type: "text", text: "more subagent work" }],
      },
    });

    const base = claudeToImport(TRANSCRIPT, META).session;
    const { session } = claudeToImport(TRANSCRIPT, META, [sub1, sub2]);

    // main 1500 in + (400 + 600) subagent = 2500
    expect(session.tokensIn).toBe(base.tokensIn! + 1000);
    expect(session.tokensIn).toBe(2500);
    // main 450 out + (200 + 100) = 750
    expect(session.tokensOut).toBe(base.tokensOut! + 300);
    expect(session.tokensCacheRead).toBe(base.tokensCacheRead! + 100);
    expect(session.tokensCacheWrite).toBe(base.tokensCacheWrite! + 50);
    // peak occupancy is still the MAIN session's live window, not a subagent sum.
    expect(session.peakContextTokens).toBe(base.peakContextTokens);
  });

  test("emits hour-bucketed cumulative samples", () => {
    const { samples } = claudeToImport(TRANSCRIPT, META);
    expect(samples.length).toBeGreaterThanOrEqual(1);
    for (const s of samples) {
      expect(s.resolution).toBe("hour");
      expect(s.sessionKey).toBe("sess-abc");
      // bucketed to the start of the hour
      expect(s.at % 3_600_000).toBe(0);
    }
    // cumulative: the last bucket holds the full running totals.
    const last = samples[samples.length - 1];
    expect(last.tokensIn).toBe(1500);
    expect(last.tokensOut).toBe(450);
  });

  test("emits started, tool, and closed events", () => {
    const { events } = claudeToImport(TRANSCRIPT, META);
    const started = events.find((e) => e.type === "session.started");
    const tool = events.find((e) => e.type === "session.tool");
    const closed = events.find((e) => e.type === "session.closed");

    expect(started).toBeDefined();
    expect(started!.at).toBe(Date.parse(T1));
    expect(started!.sessionKey).toBe("sess-abc");

    expect(tool).toBeDefined();
    expect(typeof (tool!.detail as any)?.tool).toBe("string");

    expect(closed).toBeDefined();
    expect(closed!.at).toBe(Date.parse(T3));
  });

  test("garbage/empty transcript yields a minimal session without throwing", () => {
    const { session, samples, events } = claudeToImport("not json\n\n{bad", {
      sessionId: "empty-1",
      cwd: null,
      mtime: 1234,
    });
    expect(session.sessionKey).toBe("empty-1");
    expect(session.provider).toBe("claude");
    expect(session.state).toBe("closed");
    // no timestamps -> fall back to mtime, no samples.
    expect(session.startedAt).toBe(1234);
    expect(session.endedAt).toBe(1234);
    expect(samples).toEqual([]);
    // still records the lifecycle bookends.
    expect(events.find((e) => e.type === "session.started")).toBeDefined();
    expect(events.find((e) => e.type === "session.closed")).toBeDefined();
  });
});
