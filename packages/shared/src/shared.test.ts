import { expect, test, describe } from "bun:test";
import { priceFor, estimateCost } from "./cost.ts";
import { contextWindowFor } from "./context.ts";
import { resolveCategory, FALLBACK_CATEGORY } from "./category.ts";
import { resumeCommand } from "./types.ts";

describe("cost", () => {
  test("longest-prefix model match", () => {
    expect(priceFor("claude-opus-4-8")).toEqual({ in: 5, out: 25 });
    expect(priceFor("claude-sonnet-4-6")).toEqual({ in: 3, out: 15 });
    expect(priceFor("gpt-5-mini")).toEqual({ in: 1.25, out: 10 });
  });

  test("unknown model => undefined", () => {
    expect(priceFor("llama-3")).toBeUndefined();
    expect(priceFor(undefined)).toBeUndefined();
    expect(estimateCost("llama-3", 100, 100)).toBeUndefined();
  });

  test("cost math", () => {
    // 1M in @15 + 1M out @75 = 90
    // opus 4.8: $5 in + $25 out per 1M
    expect(estimateCost("claude-opus-4-8", 1_000_000, 1_000_000)).toBe(30);
    expect(estimateCost("claude-sonnet-4-6", 0, 0)).toBe(0);
    // cache reads billed at 10% of input: 1M cache @ 5*0.1 = 0.5
    expect(estimateCost("claude-opus-4-8", 0, 0, 1_000_000)).toBe(0.5);
    // cache writes billed at 1.25x input: 1M @ 5*1.25 = 6.25
    expect(estimateCost("claude-opus-4-8", 0, 0, 0, 1_000_000)).toBe(6.25);
  });
});

describe("context window", () => {
  test("opus/fable default 1M; sonnet & haiku default 200K", () => {
    expect(contextWindowFor("claude-opus-4-8")).toBe(1_000_000);
    expect(contextWindowFor("claude-fable-5")).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet-4-6")).toBe(200_000); // 1M is opt-in beta
    expect(contextWindowFor("claude-haiku-4-5")).toBe(200_000);
    expect(contextWindowFor("gpt-5.5")).toBe(272_000);
  });

  test("[1m] beta tag forces 1M for an otherwise-200K family", () => {
    expect(contextWindowFor("claude-sonnet-4-6[1m]")).toBe(1_000_000);
  });

  test("unknown model => undefined", () => {
    expect(contextWindowFor("llama-3")).toBeUndefined();
    expect(contextWindowFor(undefined)).toBeUndefined();
  });
});

describe("category", () => {
  test("byCwd beats byProvider", () => {
    const cfg = {
      byProvider: { claude: "code" },
      byCwd: [{ match: /vault/, category: "vault" }],
    };
    expect(resolveCategory("claude", "/home/me/vault", "code", cfg)).toBe("vault");
    expect(resolveCategory("claude", "/home/me/app", "code", cfg)).toBe("code");
  });

  test("byProvider beats providerDefault", () => {
    expect(resolveCategory("codex", null, "code", { byProvider: { codex: "review" } })).toBe("review");
  });

  test("falls back through chain", () => {
    expect(resolveCategory("hermes", null, "personal", {})).toBe("personal");
    expect(resolveCategory("mystery", null, undefined, {})).toBe(FALLBACK_CATEGORY);
  });
});

describe("resumeCommand", () => {
  test("claude builds a --resume command scoped to cwd", () => {
    expect(resumeCommand({ provider: "claude", resumeId: "abc-123", cwd: "/repo" }))
      .toBe("cd '/repo' && claude --resume abc-123");
  });
  test("codex uses positional resume", () => {
    expect(resumeCommand({ provider: "codex", resumeId: "uuid-9", cwd: "/x" }))
      .toBe("cd '/x' && codex resume uuid-9");
  });
  test("quotes cwd with spaces", () => {
    expect(resumeCommand({ provider: "claude", resumeId: "x", cwd: "/Users/me/My Projects" }))
      .toBe("cd '/Users/me/My Projects' && claude --resume x");
  });
  test("missing resumeId yields null (icon disabled)", () => {
    expect(resumeCommand({ provider: "opencode", resumeId: undefined, cwd: "/x" }))
      .toBeNull();
  });
  test("unknown provider falls back to bare id", () => {
    expect(resumeCommand({ provider: "mystery", resumeId: "z", cwd: null }))
      .toBe("z");
  });
  test("hermes resume has no cd prefix", () => {
    expect(resumeCommand({ provider: "hermes", resumeId: "abc", cwd: null }))
      .toBe("hermes --resume abc");
  });
  test("hermes ignores cwd (cwd-agnostic daemon)", () => {
    expect(resumeCommand({ provider: "hermes", resumeId: "abc", cwd: "/whatever" }))
      .toBe("hermes --resume abc");
  });
  test("hermes with no resumeId is null (disabled)", () => {
    expect(resumeCommand({ provider: "hermes", resumeId: undefined, cwd: null }))
      .toBeNull();
  });
});
