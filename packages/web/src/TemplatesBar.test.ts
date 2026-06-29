import { test, expect } from "bun:test";
import { parseArgs } from "./TemplatesBar.tsx";

test("empty / whitespace-only input yields no args", () => {
  expect(parseArgs("")).toEqual([]);
  expect(parseArgs("   \t  ")).toEqual([]);
});

test("plain whitespace-separated tokens", () => {
  expect(parseArgs("--model opus")).toEqual(["--model", "opus"]);
  expect(parseArgs("  --model    opus  ")).toEqual(["--model", "opus"]);
});

test("quoted span keeps spaces and strips quote chars", () => {
  expect(parseArgs('--msg "hello world"')).toEqual(["--msg", "hello world"]);
});

test("mid-token double-quote: --flag=\"value with spaces\"", () => {
  expect(parseArgs('--flag="value with spaces"')).toEqual(["--flag=value with spaces"]);
});

test("single-quote variant works the same", () => {
  expect(parseArgs("--flag='value with spaces'")).toEqual(["--flag=value with spaces"]);
  expect(parseArgs("--msg 'hello world'")).toEqual(["--msg", "hello world"]);
});
