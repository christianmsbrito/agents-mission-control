import { expect, test, describe } from "bun:test";
import { Summarizer } from "./summarizer.ts";

describe("Summarizer", () => {
  test("inactive when no generator", () => {
    const s = new Summarizer(null);
    expect(s.active).toBe(false);
    expect(s.analyze("x", "some text")).toEqual({ fresh: true });
  });

  test("returns stale until refresh lands, then caches as fresh", async () => {
    let calls = 0;
    const s = new Summarizer(async (t) => ({ summary: `recap of ${t.recent.length} chars #${++calls}` }), {
      minIntervalMs: 0,
    });
    // first call: schedules, returns empty + not fresh
    expect(s.analyze("sess", "hello world")).toEqual({ fresh: false });
    await s.settle();
    // now cached for that exact text => fresh
    const r = s.analyze("sess", "hello world");
    expect(r.summary).toBe("recap of 11 chars #1");
    expect(r.fresh).toBe(true);
    expect(calls).toBe(1);
  });

  test("changed text is reported NOT fresh (stale action flags suppressed)", async () => {
    const s = new Summarizer(async () => ({ summary: "asked?", awaitingUser: true }), {
      minIntervalMs: 10 * 60_000, // long throttle so the change can't refresh
      now: () => 1000,
    });
    s.analyze("a", "v1");
    await s.settle(); // caches awaitingUser:true for v1
    // transcript moved on to v2; throttled => stale result, fresh:false
    const r = s.analyze("a", "v2 — different now");
    expect(r.awaitingUser).toBe(true); // stale value still present...
    expect(r.fresh).toBe(false); // ...but marked stale so collect won't honor it
  });

  test("re-analyzes when text changes (throttle open)", async () => {
    let calls = 0;
    const s = new Summarizer(async () => ({ summary: `r${++calls}` }), { minIntervalMs: 0 });
    s.analyze("a", "first");
    await s.settle();
    s.analyze("a", "second changed");
    await s.settle();
    expect(s.analyze("a", "second changed").summary).toBe("r2");
    expect(calls).toBe(2);
  });

  test("throttles within minIntervalMs", async () => {
    let calls = 0;
    let t = 1000;
    const s = new Summarizer(async () => ({ summary: `r${++calls}` }), {
      minIntervalMs: 1000,
      now: () => t,
    });
    s.analyze("a", "v1");
    await s.settle();
    t = 1500; // within window
    expect(s.analyze("a", "v2").summary).toBe("r1"); // stale, no new call
    expect(calls).toBe(1);
    t = 2100; // window elapsed
    s.analyze("a", "v2");
    await s.settle();
    expect(calls).toBe(2);
  });

  test("setMinInterval applies the new throttle live", async () => {
    let calls = 0;
    let t = 1000;
    const s = new Summarizer(async () => ({ summary: `r${++calls}` }), {
      minIntervalMs: 10 * 60_000, // long throttle so a quick second run is suppressed
      now: () => t,
    });
    s.analyze("a", "v1");
    await s.settle();
    expect(calls).toBe(1);
    t = 1500; // well within the long window
    s.analyze("a", "v2");
    await s.settle();
    expect(calls).toBe(1); // suppressed by throttle
    s.setMinInterval(0); // open the throttle live
    s.analyze("a", "v2");
    await s.settle();
    expect(calls).toBe(2); // now runs
  });

  test("survives generator errors, keeps last good", async () => {
    let calls = 0;
    const s = new Summarizer(
      async () => {
        calls++;
        if (calls === 2) throw new Error("api down");
        return { summary: `r${calls}` };
      },
      { minIntervalMs: 0 },
    );
    s.analyze("a", "v1");
    await s.settle();
    s.analyze("a", "v2"); // throws internally
    await s.settle();
    expect(s.analyze("a", "v2").summary).toBe("r1"); // retained
  });
});
