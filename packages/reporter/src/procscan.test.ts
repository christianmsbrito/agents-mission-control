import { expect, test } from "bun:test";
import { parseTemplateIdFromEnv } from "./procscan.ts";

test("parseTemplateIdFromEnv reads MC_TEMPLATE_ID from `ps eww` style (space-separated)", () => {
  expect(parseTemplateIdFromEnv("PID TT  STAT  TIME COMMAND\n123 s001 S 0:01 claude PATH=/usr/bin MC_TEMPLATE_ID=feat TERM=xterm")).toBe("feat");
});
test("parseTemplateIdFromEnv reads NUL-separated /proc environ", () => {
  expect(parseTemplateIdFromEnv("PATH=/usr/bin\0MC_TEMPLATE_ID=code-review\0TERM=xterm")).toBe("code-review");
});
test("parseTemplateIdFromEnv returns null when absent", () => {
  expect(parseTemplateIdFromEnv("PATH=/usr/bin TERM=xterm")).toBeNull();
});
test("parseTemplateIdFromEnv stops at whitespace/NUL boundary", () => {
  expect(parseTemplateIdFromEnv("A=1 MC_TEMPLATE_ID=my-lord OTHER=2")).toBe("my-lord");
  expect(parseTemplateIdFromEnv("MC_TEMPLATE_ID=x\0Y=2")).toBe("x");
});
test("parseTemplateIdFromEnv requires a left boundary (ignores suffixed vars)", () => {
  expect(parseTemplateIdFromEnv("FOO_MC_TEMPLATE_ID=wrong")).toBeNull();
  expect(parseTemplateIdFromEnv("XMC_TEMPLATE_ID=wrong MC_TEMPLATE_ID=right")).toBe("right");
});
