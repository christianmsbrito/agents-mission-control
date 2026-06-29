import { expect, test, describe } from "bun:test";
import { slugify, validateTemplateInput, templateLevel } from "./template.ts";

describe("slugify", () => {
  test("kebab-cases a name", () => {
    expect(slugify("Code Review Lord")).toBe("code-review-lord");
  });
  test("strips junk and collapses dashes", () => {
    expect(slugify("  Feature!! Lord  ")).toBe("feature-lord");
  });
});

describe("validateTemplateInput backend", () => {
  test("defaults to iterm2 when omitted", () => {
    const r = validateTemplateInput({ name: "X", provider: "claude" });
    expect(r.ok && r.value.backend).toBe("iterm2");
  });
  test("accepts tmux", () => {
    const r = validateTemplateInput({ name: "X", provider: "claude", backend: "tmux" });
    expect(r.ok && r.value.backend).toBe("tmux");
  });
  test("rejects an unknown backend", () => {
    expect(validateTemplateInput({ name: "X", provider: "claude", backend: "kitty" }).ok).toBe(false);
  });
});

describe("validateTemplateInput", () => {
  test("accepts a minimal valid template", () => {
    const r = validateTemplateInput({ name: "Feature Lord", provider: "claude" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe("feature-lord");
      expect(r.value.provider).toBe("claude");
      expect(r.value.args).toEqual([]);
    }
  });
  test("honors an explicit id", () => {
    const r = validateTemplateInput({ id: "cr", name: "X", provider: "codex" });
    expect(r.ok && r.value.id).toBe("cr");
  });
  test("rejects missing name", () => {
    expect(validateTemplateInput({ provider: "claude" }).ok).toBe(false);
  });
  test("rejects missing provider", () => {
    expect(validateTemplateInput({ name: "X" }).ok).toBe(false);
  });
  test("rejects non-string args entries", () => {
    expect(validateTemplateInput({ name: "X", provider: "claude", args: [1] as any }).ok).toBe(false);
  });
  test("coerces args/prompt/cwd to clean values", () => {
    const r = validateTemplateInput({ name: "X", provider: "claude", args: ["--model", "o1"], prompt: "hi", cwd: "/tmp" });
    expect(r.ok && r.value.args).toEqual(["--model", "o1"]);
    expect(r.ok && r.value.prompt).toBe("hi");
    expect(r.ok && r.value.cwd).toBe("/tmp");
  });
});

describe("templateLevel", () => {
  test("floors at 1 for zero XP", () => {
    expect(templateLevel(0, 0)).toBe(1);
  });

  test("is monotonic non-decreasing as troops increase", () => {
    let prev = templateLevel(0, 0);
    for (let troops = 1; troops <= 200; troops++) {
      const cur = templateLevel(troops, 0);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  test("is monotonic non-decreasing as tokens increase", () => {
    let prev = templateLevel(0, 0);
    for (let tokens = 0; tokens <= 5_000_000; tokens += 50_000) {
      const cur = templateLevel(0, tokens);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  test("more troops yields a higher level", () => {
    expect(templateLevel(100, 0)).toBeGreaterThan(templateLevel(1, 0));
  });

  test("heavy token usage raises the level well above the floor", () => {
    expect(templateLevel(0, 10_000_000)).toBeGreaterThan(templateLevel(0, 0));
  });

  test("pins known points on the curve", () => {
    expect(templateLevel(0, 0)).toBe(1);
    expect(templateLevel(1, 0)).toBe(3);
    expect(templateLevel(100, 0)).toBe(21);
    expect(templateLevel(0, 10_000_000)).toBe(7);
  });
});
