import { test, expect } from "bun:test";
import { DEFAULT_PREFS, isIdle, prefsReducer, totalTokens } from "./prefs.ts";

test("toggle a category filter into the hidden set", () => {
  const next = prefsReducer(DEFAULT_PREFS, { type: "toggleHiddenCategory", value: "review" });
  expect(next.hiddenCategories).toContain("review");
  const back = prefsReducer(next, { type: "toggleHiddenCategory", value: "review" });
  expect(back.hiddenCategories).not.toContain("review");
});

test("set sort and density", () => {
  const next = prefsReducer(DEFAULT_PREFS, { type: "setSort", value: "cost" });
  expect(next.sort).toBe("cost");
  expect(prefsReducer(DEFAULT_PREFS, { type: "setDensity", value: "compact" }).density).toBe("compact");
});

test("hideIdle defaults on with a 1000-token floor and toggles cleanly", () => {
  expect(DEFAULT_PREFS.hideIdle).toBe(true);
  expect(DEFAULT_PREFS.minTokens).toBe(1000);
  const off = prefsReducer(DEFAULT_PREFS, { type: "toggle", key: "hideIdle" });
  expect(off.hideIdle).toBe(false);
  expect(off.hiddenCategories).toEqual(DEFAULT_PREFS.hiddenCategories);
  expect(prefsReducer(off, { type: "toggle", key: "hideIdle" }).hideIdle).toBe(true);
});

test("setMinTokens updates the floor (clamped to >= 0)", () => {
  expect(prefsReducer(DEFAULT_PREFS, { type: "setMinTokens", value: 500 }).minTokens).toBe(500);
  expect(prefsReducer(DEFAULT_PREFS, { type: "setMinTokens", value: -5 }).minTokens).toBe(0);
});

test("totalTokens sums all token buckets, treating absent as 0", () => {
  expect(totalTokens({ tokensIn: 10, tokensOut: 20, tokensCacheRead: 5, tokensCacheWrite: 1 })).toBe(36);
  expect(totalTokens({})).toBe(0);
});

test("isIdle is true below the floor, false at/above it", () => {
  expect(isIdle({}, 1000)).toBe(true); // 0-token phantom
  expect(isIdle({ tokensIn: 999 }, 1000)).toBe(true);
  expect(isIdle({ tokensIn: 1000 }, 1000)).toBe(false);
  expect(isIdle({ tokensOut: 5000 }, 1000)).toBe(false);
});
