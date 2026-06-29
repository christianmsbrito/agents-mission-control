import { expect, test, describe } from "bun:test";
import { historyQueryString, sparklinePoints } from "./useHistory.ts";

describe("historyQueryString", () => {
  test("builds query string omitting empties", () => {
    expect(historyQueryString({ state: "closed", provider: "", limit: 50 })).toBe(
      "state=closed&limit=50",
    );
  });
  test("empty filter yields empty string", () => {
    expect(historyQueryString({})).toBe("");
  });
  test("drops undefined and empty values, coerces numbers", () => {
    expect(
      historyQueryString({
        state: undefined,
        provider: "claude",
        category: "",
        cwd: undefined,
        limit: 100,
        offset: 0,
      }),
    ).toBe("provider=claude&limit=100&offset=0");
  });
  test("includes since/until when present", () => {
    expect(historyQueryString({ since: 123, until: 456 })).toBe("since=123&until=456");
  });
});

describe("sparklinePoints", () => {
  test("empty series yields empty string", () => {
    expect(sparklinePoints([], 100, 20)).toBe("");
  });
  test("single value plots a flat baseline point", () => {
    // one point -> single coordinate at x=0
    expect(sparklinePoints([5], 100, 20)).toBe("0,10");
  });
  test("maps min to bottom and max to top across the width", () => {
    // values 0..10 over width 100, height 20:
    // first x=0 (min -> y=height=20), last x=100 (max -> y=0)
    const pts = sparklinePoints([0, 10], 100, 20).split(" ");
    expect(pts[0]).toBe("0,20");
    expect(pts[1]).toBe("100,0");
  });
  test("flat non-zero series sits on the baseline", () => {
    const pts = sparklinePoints([7, 7, 7], 100, 20).split(" ");
    expect(pts).toEqual(["0,10", "50,10", "100,10"]);
  });
});
