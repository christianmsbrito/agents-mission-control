import { test, expect, describe } from "bun:test";
import { pointsToSamples, peakOf, truncate, trimTail, buildClosedSession, type Point } from "./_common.ts";

const HOUR = 3_600_000;

function pt(at: number, over: Partial<Point> = {}): Point {
  return {
    at,
    cost_usd: null,
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    context_tokens: 0,
    context_window: null,
    cpu: null,
    mem_mb: null,
    active: 0,
    ...over,
  };
}

describe("peakOf", () => {
  test("returns undefined for no points", () => {
    expect(peakOf([])).toBeUndefined();
  });
  test("returns the MAX context_tokens, not the last", () => {
    const points = [pt(1, { context_tokens: 1600 }), pt(2, { context_tokens: 700 })];
    expect(peakOf(points)).toBe(1600);
  });
});

describe("pointsToSamples", () => {
  test("groups by hour bucket, sorts ascending, emits cumulative hour rows", () => {
    const base = Date.parse("2026-06-15T10:00:00.000Z");
    const points = [
      pt(base + 5 * 60_000, { tokens_in: 100, tokens_out: 30 }),
      pt(base + 20 * 60_000, { tokens_in: 200, tokens_out: 60 }), // same hour, later → cumulative wins
      pt(base + HOUR + 60_000, { tokens_in: 500, tokens_out: 150 }), // next hour
    ];
    const samples = pointsToSamples(points, "sess-1");
    expect(samples.length).toBe(2);
    for (const s of samples) {
      expect(s.resolution).toBe("hour");
      expect(s.sessionKey).toBe("sess-1");
      expect(s.at % HOUR).toBe(0);
    }
    // ascending bucket order
    expect(samples[0].at).toBeLessThan(samples[1].at);
    // cumulative LAST-in-bucket wins
    expect(samples[0].tokensIn).toBe(200);
    expect(samples[1].tokensIn).toBe(500);
  });

  test("empty points → no samples", () => {
    expect(pointsToSamples([], "sess-1")).toEqual([]);
  });
});

describe("truncate", () => {
  test("undefined passthrough and length cap", () => {
    expect(truncate(undefined)).toBeUndefined();
    expect(truncate("")).toBeUndefined();
    expect(truncate("short")).toBe("short");
    expect(truncate("abcdef", 3)).toBe("abc");
  });
});

describe("trimTail", () => {
  test("keeps the LAST n chars", () => {
    expect(trimTail(undefined)).toBe("");
    expect(trimTail("abcdef", 3)).toBe("def");
    expect(trimTail("abc", 10)).toBe("abc");
  });
});

describe("buildClosedSession", () => {
  test("throws on an empty sessionKey (orchestrator turns it into a skip)", () => {
    expect(() =>
      buildClosedSession({
        provider: "codex",
        sessionKey: "",
        resumeId: undefined,
        cwd: null,
        startedAt: 1,
        endedAt: 2,
        category: "review",
        enrichment: {},
        points: [],
      }),
    ).toThrow();
  });

  test("falls back to enr.contextTokens for peak when there are no points", () => {
    const { session } = buildClosedSession({
      provider: "claude",
      sessionKey: "k",
      resumeId: "k",
      cwd: null,
      startedAt: 1,
      endedAt: 2,
      category: "code",
      enrichment: { contextTokens: 42 },
      points: [],
    });
    expect(session.peakContextTokens).toBe(42);
  });

  test("sets session.costUsd from the optional costUsd arg; omitting it leaves it undefined", () => {
    const withCost = buildClosedSession({
      provider: "openclaw",
      sessionKey: "k",
      resumeId: "k",
      cwd: null,
      startedAt: 1,
      endedAt: 2,
      category: "personal",
      enrichment: {},
      points: [],
      costUsd: 0.42,
    });
    expect(withCost.session.costUsd).toBe(0.42);

    const noCost = buildClosedSession({
      provider: "claude",
      sessionKey: "k",
      resumeId: "k",
      cwd: null,
      startedAt: 1,
      endedAt: 2,
      category: "code",
      enrichment: {},
      points: [],
    });
    expect(noCost.session.costUsd).toBeUndefined();
  });

  test("emits an errored bookend only when errored is set", () => {
    const withErr = buildClosedSession({
      provider: "claude",
      sessionKey: "k",
      resumeId: "k",
      cwd: null,
      startedAt: 1,
      endedAt: 2,
      category: "code",
      enrichment: {},
      points: [],
      errored: true,
    });
    expect(withErr.events.find((e) => e.type === "session.errored")).toBeDefined();

    const noErr = buildClosedSession({
      provider: "codex",
      sessionKey: "k",
      resumeId: "k",
      cwd: null,
      startedAt: 1,
      endedAt: 2,
      category: "review",
      enrichment: {},
      points: [],
    });
    expect(noErr.events.find((e) => e.type === "session.errored")).toBeUndefined();
  });
});
