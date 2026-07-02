import { expect, test, describe } from "bun:test";
import { classifyCrash, battleStateOf, activeFraction } from "./rpg.ts";

describe("activeFraction", () => {
  test("uses endedAt for a normally-closed session", () => {
    // active 30m of a 60m lifespan.
    expect(activeFraction({ activeMs: 1_800_000, startedAt: 0, endedAt: 3_600_000, lastSeenAt: 3_600_000 }))
      .toBeCloseTo(0.5, 5);
  });

  test("a stale ended_at (< lastSeenAt) cannot shrink the denominator to inflate active%", () => {
    // Resumed-session corruption: ended_at is the first run's close (49m) but the
    // session actually lived ~35h (lastSeenAt) and accrued ~5.25h active. The gauge
    // must reflect the observed span, not clamp to 100% off the stale 49m.
    const f = activeFraction({
      activeMs: 18_900_000,          // 315m active
      startedAt: 0,
      endedAt: 2_957_800,            // stale 49.3m
      lastSeenAt: 127_140_722,       // true 2119m span
    });
    expect(f).toBeCloseTo(18_900_000 / 127_140_722, 4); // ~0.149, NOT 1.0
  });

  test("undefined when activeMs absent", () => {
    expect(activeFraction({ startedAt: 0, lastSeenAt: 100 })).toBeUndefined();
  });
});

describe("classifyCrash", () => {
  test("maps real crash texts to suggested-action keys", () => {
    expect(classifyCrash("Please run /login · API Error: 401 Invalid authentication credentials")).toBe("reauth");
    expect(classifyCrash("API Error: 401 invalid auth")).toBe("reauth");
    expect(classifyCrash("There's an issue with the selected model (claude-fable-5[1m]). Run /model to pick another.")).toBe("model");
    expect(classifyCrash("API Error: 529 overloaded_error")).toBe("transient");
    expect(classifyCrash("API Error: 500 Internal server error. This is a server-side issue, usually temporary")).toBe("transient");
    expect(classifyCrash("API Error: Stream idle timeout - partial response received")).toBe("connection");
    expect(classifyCrash("API Error: Unable to connect to API (ConnectionRefused)")).toBe("connection");
    expect(classifyCrash("prompt is too long: context length exceeded")).toBe("context");
  });

  test("uses errorTransient flag when text has no specific signal", () => {
    expect(classifyCrash("Tool failed: invalid state", true)).toBe("transient");
    expect(classifyCrash("Tool failed: invalid state", false)).toBe("generic");
    expect(classifyCrash(undefined, false)).toBe("generic");
    expect(classifyCrash(undefined, undefined)).toBe("generic");
  });

  test("context signal beats connection/transient (more specific)", () => {
    // a context-window error that also mentions a timeout-ish word must classify as context
    expect(classifyCrash("context window full; compact and try again")).toBe("context");
  });
});

describe("battleStateOf + classifyCrash composition (TASK-11/12 interplay)", () => {
  test("recovered session (errored cleared) is no longer ko, so no crash balloon", () => {
    // Once the reporter clears errored on recovery, the card state falls back to
    // active/awaiting/resting — the warn balloon branch (gated on s.errored) is
    // never taken, so no stale crash message can linger.
    expect(battleStateOf({ errored: true })).toBe("ko");
    expect(battleStateOf({ errored: false, active: true })).toBe("battle");
    expect(battleStateOf({ active: true })).toBe("battle");
  });
});
