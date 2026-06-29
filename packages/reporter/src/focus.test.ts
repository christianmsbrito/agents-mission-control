import { expect, test, describe } from "bun:test";
import { parsePanePidMap } from "./focus.ts";

describe("parsePanePidMap", () => {
  test("maps pane_pid -> {session, windowId, paneId}", () => {
    const out = "30138\t0\t@0\t%0\n99234\tmc-focus\t@10\t%13";
    const map = parsePanePidMap(out);
    expect(map.size).toBe(2);
    expect(map.get(99234)).toEqual({ session: "mc-focus", windowId: "@10", paneId: "%13" });
    expect(map.get(30138)).toEqual({ session: "0", windowId: "@0", paneId: "%0" });
  });
  test("skips blank and malformed lines", () => {
    const out = "\nbad-line\n42\tsess\t@1\t%1\n";
    const map = parsePanePidMap(out);
    expect(map.size).toBe(1);
    expect(map.get(42)).toEqual({ session: "sess", windowId: "@1", paneId: "%1" });
  });
  test("empty output yields an empty map", () => {
    expect(parsePanePidMap("").size).toBe(0);
  });
});
