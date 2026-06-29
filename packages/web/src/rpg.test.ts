import { expect, test, describe } from "bun:test";
import { classifyCrash, battleStateOf } from "./rpg.ts";

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
