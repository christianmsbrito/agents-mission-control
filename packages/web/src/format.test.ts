import { expect, test, describe } from "bun:test";
import { fmtUptime, fmtCost, fmtTokens, fmtAgo } from "./format.ts";

describe("format", () => {
  test("uptime", () => {
    const now = 10_000_000;
    expect(fmtUptime(now - 5_000, now)).toBe("5s");
    expect(fmtUptime(now - 125_000, now)).toBe("2m 5s");
    expect(fmtUptime(now - 3_700_000, now)).toBe("1h 1m 40s");
  });
  test("ago", () => {
    const now = 10_000_000;
    expect(fmtAgo(undefined, now)).toBe("—");
    expect(fmtAgo(now - 2_000, now)).toBe("now");
    expect(fmtAgo(now - 30_000, now)).toBe("30s ago");
    expect(fmtAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(fmtAgo(now - 3 * 3600_000, now)).toBe("3h ago");
    expect(fmtAgo(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  test("cost", () => {
    expect(fmtCost(undefined)).toBe("—");
    expect(fmtCost(0.003)).toBe("<$0.01");
    expect(fmtCost(1.234)).toBe("$1.23");
  });
  test("tokens", () => {
    expect(fmtTokens(undefined)).toBe("—");
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(2300)).toBe("2.3k");
    expect(fmtTokens(1_500_000)).toBe("1.5M");
  });
});
