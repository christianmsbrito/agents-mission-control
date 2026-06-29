import { expect, test, describe } from "bun:test";
import { parseItermTabs, buildLaunchLine } from "./iterm.ts";

describe("parseItermTabs", () => {
  test("parses sessionId/title records", () => {
    const out = "ABC-123\ttutors (zsh)\nDEF-456\tai-matching-engine\n";
    expect(parseItermTabs(out)).toEqual([
      { sessionId: "ABC-123", title: "tutors (zsh)" },
      { sessionId: "DEF-456", title: "ai-matching-engine" },
    ]);
  });
  test("empty / iTerm-down output yields []", () => {
    expect(parseItermTabs("")).toEqual([]);
    expect(parseItermTabs("\n  \n")).toEqual([]);
  });
  test("keeps an empty title but requires a session id", () => {
    expect(parseItermTabs("ABC-123\t")).toEqual([{ sessionId: "ABC-123", title: "" }]);
    expect(parseItermTabs("\tno-id")).toEqual([]);
  });
});

describe("buildLaunchLine", () => {
  test("env-tags the agent and shell-quotes tokens", () => {
    expect(buildLaunchLine("codex", ["--model", "o1"], "code-review")).toBe(
      "env MC_TEMPLATE_ID='code-review' 'codex' '--model' 'o1'",
    );
  });
  test("prepends cd when a cwd is given", () => {
    expect(buildLaunchLine("claude", [], "feat", "/repo")).toBe(
      "cd '/repo' && env MC_TEMPLATE_ID='feat' 'claude'",
    );
  });
});
