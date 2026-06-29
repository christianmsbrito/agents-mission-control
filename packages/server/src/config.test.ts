import { test, expect } from "bun:test";
import { defaultConfig, mergeConfig, applySettings } from "./config.ts";

test("defaultConfig pulls staleMs from env default", () => {
  expect(defaultConfig({}).staleMs).toBe(10_000);
  expect(defaultConfig({ MC_STALE_MS: "5000" }).staleMs).toBe(5000);
});

test("mergeConfig overlays a persisted file over defaults", () => {
  const merged = mergeConfig(defaultConfig({}), { staleMs: 4000 });
  expect(merged.staleMs).toBe(4000);
  expect(merged.summaries.enabled).toBe(true); // default preserved
});

test("applySettings deep-merges a patch and clamps staleMs to a 2000ms floor", () => {
  const base = defaultConfig({});
  const next = applySettings(base, { staleMs: 100 });
  expect(next.staleMs).toBe(2000); // clamped
  const cats = applySettings(base, { categories: { byProvider: { codex: "review" } } });
  expect(cats.categories.byProvider).toEqual({ codex: "review" });
});
