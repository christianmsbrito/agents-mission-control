import { test, expect, describe } from "bun:test";
import { codexToImport, codexBackfillAdapter } from "./codex.ts";
import { parseCodexRollout } from "../../../../reporter/src/providers/codex.ts";

const UUID = "019eccbe-739e-7481-9607-21adaa4d4f26";
const T_META = "2026-06-15T19:24:54.064Z"; // session_meta.payload.timestamp (start)
const T1 = "2026-06-15T19:26:23.939Z"; // first token_count (higher occupancy)
const T2 = "2026-06-15T20:30:00.000Z"; // second token_count (last; lower occupancy)

// session_meta + 2 token_count event_msg envelopes + a function_call response_item.
const ROLLOUT = [
  JSON.stringify({
    timestamp: "2026-06-15T19:26:09.240Z",
    type: "session_meta",
    payload: {
      id: UUID,
      timestamp: T_META,
      cwd: "/tmp/proj",
      model_provider: "openai",
    },
  }),
  JSON.stringify({
    timestamp: T1,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 200,
          output_tokens: 300,
          total_tokens: 1300,
        },
        // per-turn occupancy this turn — the HIGHER one (not the last event).
        last_token_usage: { total_tokens: 5000 },
        model_context_window: 258400,
      },
    },
  }),
  JSON.stringify({
    timestamp: "2026-06-15T19:26:25.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "git status", workdir: "/tmp/proj" }),
      call_id: "call_1",
    },
  }),
  JSON.stringify({
    timestamp: T2,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 2000,
          cached_input_tokens: 400,
          output_tokens: 600,
          total_tokens: 2600,
        },
        // LAST turn occupancy — lower than the earlier turn above.
        last_token_usage: { total_tokens: 2200 },
        model_context_window: 258400,
      },
    },
  }),
  JSON.stringify({
    timestamp: "2026-06-15T19:25:00.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "fix the build" },
  }),
].join("\n");

const META = { mtime: Date.parse("2026-06-15T21:00:00.000Z") };

describe("codexToImport", () => {
  test("builds a closed codex session keyed by the session_meta UUID", () => {
    const enr = parseCodexRollout(ROLLOUT);
    const { session } = codexToImport(ROLLOUT, META);

    expect(session.provider).toBe("codex");
    expect(session.sessionKey).toBe(UUID);
    expect(session.resumeId).toBe(UUID);
    expect(session.state).toBe("closed");
    expect(session.cwd).toBe("/tmp/proj");

    // token rollups line up with parseCodexRollout (no duplicate aggregation).
    expect(session.tokensIn).toBe(enr.tokensIn);
    expect(session.tokensOut).toBe(enr.tokensOut);
    expect(session.tokensCacheRead).toBe(enr.tokensCacheRead);
    // codex has no cache-write tokens.
    expect(session.tokensCacheWrite).toBeUndefined();

    expect(session.toolsUsed).toContain("exec_command");

    // started at session_meta.timestamp; ended at the last event ts.
    expect(session.startedAt).toBe(Date.parse(T_META));
    expect(session.endedAt).toBe(Date.parse(T2));
    expect(session.lastSeenAt).toBe(Date.parse(T2));
  });

  test("leaves summary null and sets a heuristic subject (Haiku fills summary in BF10)", () => {
    const enr = parseCodexRollout(ROLLOUT);
    const { session } = codexToImport(ROLLOUT, META);
    expect(session.summary).toBeUndefined();
    expect(session.subject).toBeDefined();
    expect(session.subject).toBe(enr.subjectInput);
  });

  test("peakContextTokens is the MAX turn occupancy, not the last turn's", () => {
    const { session } = codexToImport(ROLLOUT, META);
    // first turn last_token_usage.total_tokens = 5000; last turn = 2200.
    expect(session.peakContextTokens).toBe(5000);
  });

  test("emits hour-bucketed samples carrying the context window", () => {
    const { samples } = codexToImport(ROLLOUT, META);
    expect(samples.length).toBeGreaterThanOrEqual(1);
    for (const s of samples) {
      expect(s.resolution).toBe("hour");
      expect(s.sessionKey).toBe(UUID);
      expect(s.at % 3_600_000).toBe(0);
      expect(s.contextWindow).toBe(258400);
    }
    // cumulative: last bucket holds the full totals.
    const last = samples[samples.length - 1];
    expect(last.tokensIn).toBe(1600); // 2000 - 400 cached
    expect(last.tokensOut).toBe(600);
  });

  test("emits started, tool, and closed events", () => {
    const { events } = codexToImport(ROLLOUT, META);
    expect(events.find((e) => e.type === "session.started")).toBeDefined();
    expect(events.find((e) => e.type === "session.tool")).toBeDefined();
    expect(events.find((e) => e.type === "session.closed")).toBeDefined();
  });

  test("sessionKey extracts the filename UUID (not the hyphenated ISO ts prefix)", () => {
    // The ISO timestamp prefix also contains hyphens, so the regex must anchor on
    // the canonical UUID shape to match session_meta.id (== codexToImport's key).
    const path = `/Users/x/.codex/sessions/2026/05/05/rollout-2026-05-05T23-32-29-${UUID}.jsonl`;
    expect(codexBackfillAdapter.sessionKey({ path, mtime: 0 })).toBe(UUID);
  });

  test("meta-less rollout (no resolvable session id) throws so the orchestrator skips it", () => {
    // No session_meta → no session id → an unkeyed `sessionKey:""` registry row
    // would be a primary-key collision. The shared builder refuses it by throwing;
    // the orchestrator's per-session guard turns that into a counted skip (rather
    // than importing a garbage row). See _common.buildClosedSession.
    expect(() => codexToImport("not json\n\n{bad", META)).toThrow();
    expect(() => codexToImport("", META)).toThrow();
  });
});
