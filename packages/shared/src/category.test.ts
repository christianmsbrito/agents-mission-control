import { test, expect } from "bun:test";
import { compileCwdRules, resolveCategory, type SerializableCategoryConfig } from "./category.ts";

test("compileCwdRules turns string patterns into RegExp rules", () => {
  const cfg: SerializableCategoryConfig = { byCwd: [{ match: "/work/", category: "code" }] };
  const compiled = compileCwdRules(cfg);
  expect(resolveCategory("claude", "/work/app", undefined, compiled)).toBe("code");
});

test("compileCwdRules drops invalid regex without throwing", () => {
  const cfg: SerializableCategoryConfig = { byCwd: [{ match: "(", category: "x" }] };
  const compiled = compileCwdRules(cfg);
  expect(compiled.byCwd).toEqual([]); // bad pattern skipped
  expect(resolveCategory("claude", "/work", "research", compiled)).toBe("research");
});
