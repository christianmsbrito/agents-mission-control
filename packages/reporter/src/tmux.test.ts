import { expect, test, describe } from "bun:test";
import { newWindowArgs, splitWindowArgs, launchKeysArgs, spawn, parseTmuxWindows, pickAttachedSession, splitDir, normalizeTty } from "./tmux.ts";

describe("normalizeTty", () => {
  test("strips /dev/ to match ps/procscan form", () => {
    expect(normalizeTty("/dev/ttys025")).toBe("ttys025");
    expect(normalizeTty("ttys025")).toBe("ttys025");
    expect(normalizeTty("  /dev/ttys003\n")).toBe("ttys003");
  });
});

describe("splitDir (fibonacci tiling)", () => {
  test("splits left/right (-h) when the pane is visually wide (cols > 2·rows)", () => {
    expect(splitDir(200, 50)).toBe("-h"); // 200 > 100
  });
  test("splits top/bottom (-v) when squareish or tall", () => {
    expect(splitDir(100, 50)).toBe("-v"); // 100 > 100 is false → spiral turns
    expect(splitDir(80, 50)).toBe("-v");
  });
  test("alternates as a pane keeps subdividing (spiral)", () => {
    // full → -h ; right half (≈100x50) → -v ; bottom-right (≈100x24) → -h ...
    expect(splitDir(200, 50)).toBe("-h");
    expect(splitDir(100, 50)).toBe("-v");
    expect(splitDir(100, 24)).toBe("-h");
  });
  test("degenerate sizes fall back to -v", () => {
    expect(splitDir(0, 0)).toBe("-v");
  });
});

describe("splitWindowArgs direction", () => {
  test("includes the direction flag before -t when given", () => {
    expect(splitWindowArgs("@1", "/r", { MC_TEMPLATE_ID: "x" }, "-h")).toEqual([
      "split-window", "-h", "-t", "@1", "-c", "/r", "-e", "MC_TEMPLATE_ID=x",
      "-P", "-F", "#{window_id} #{pane_id}",
    ]);
  });
});

describe("pickAttachedSession", () => {
  test("returns the session of the most-recently-active attached client", () => {
    // client_activity \t session_name
    const out = "1781900000\tmain\n1781999999\twork\n1781800000\tmain";
    expect(pickAttachedSession(out)).toBe("work");
  });
  test("returns null when no clients are attached", () => {
    expect(pickAttachedSession("")).toBeNull();
    expect(pickAttachedSession("\n  \n")).toBeNull();
  });
  test("tolerates session names (no tabs in names) and skips malformed lines", () => {
    expect(pickAttachedSession("oops-no-tab\n1781900000\tsolo")).toBe("solo");
  });
});

describe("parseTmuxWindows", () => {
  test("parses id/name/session/active from tab-separated rows", () => {
    const out = "@4\tfeature-lord\tmission-control\t1\n@5\tzsh\tmission-control\t0\n@1\tedit\twork\t0";
    expect(parseTmuxWindows(out)).toEqual([
      { id: "@4", name: "feature-lord", session: "mission-control", active: true },
      { id: "@5", name: "zsh", session: "mission-control", active: false },
      { id: "@1", name: "edit", session: "work", active: false },
    ]);
  });
  test("returns [] for empty output and skips blank/malformed lines", () => {
    expect(parseTmuxWindows("")).toEqual([]);
    expect(parseTmuxWindows("\n  \n")).toEqual([]);
    expect(parseTmuxWindows("@7\t\tsolo\t0")).toEqual([
      { id: "@7", name: "", session: "solo", active: false },
    ]);
  });
});

describe("tmux argv builders", () => {
  test("new-window targets session, names window, sets cwd, env via -e, prints ids", () => {
    expect(newWindowArgs("mc", "feature-lord", "/repo", { MC_TEMPLATE_ID: "feat" })).toEqual([
      "new-window", "-t", "mc", "-n", "feature-lord", "-c", "/repo",
      "-e", "MC_TEMPLATE_ID=feat",
      "-P", "-F", "#{window_id} #{pane_id}",
    ]);
  });
  test("new-window omits -c and -e when no cwd / no env", () => {
    expect(newWindowArgs("mc", "lord", null)).toEqual([
      "new-window", "-t", "mc", "-n", "lord",
      "-P", "-F", "#{window_id} #{pane_id}",
    ]);
  });
  test("split-window targets an existing window id with env", () => {
    expect(splitWindowArgs("@4", "/repo", { MC_TEMPLATE_ID: "feat" })).toEqual([
      "split-window", "-t", "@4", "-c", "/repo",
      "-e", "MC_TEMPLATE_ID=feat",
      "-P", "-F", "#{window_id} #{pane_id}",
    ]);
  });
  test("split-window omits -c and -e when bare", () => {
    expect(splitWindowArgs("@4")).toEqual([
      "split-window", "-t", "@4",
      "-P", "-F", "#{window_id} #{pane_id}",
    ]);
  });
  test("launch keys send the command literally then Enter", () => {
    const argv = launchKeysArgs("%7", "claude --model o1");
    expect(argv).toEqual(["send-keys", "-t", "%7", "-l", "claude --model o1"]);
  });
});

describe("spawn cwd validation", () => {
  test("rejects a nonexistent cwd before running any tmux command", async () => {
    const res = await spawn({
      cmd: "true", args: [], templateId: "t", name: "t",
      cwd: "/nonexistent-mc-spawn-xyz",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("cwd");
    expect(res.error).toContain("/nonexistent-mc-spawn-xyz");
    // The guard returns before resolveSession/tmux, so no window/pane ids exist.
    expect(res.windowId).toBeUndefined();
    expect(res.paneId).toBeUndefined();
  });
});
