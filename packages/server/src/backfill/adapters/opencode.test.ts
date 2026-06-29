import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeToImport, opencodeBackfillAdapter, type OcSessionRow, type OcMessageRow } from "./opencode.ts";

const CREATED = 1_771_338_025_707;
const UPDATED = 1_771_338_138_752;

const SESSION: OcSessionRow = {
  id: "ses_abc123",
  directory: "/Users/me/Development/proj",
  title: "Quick test check",
  time: { created: CREATED, updated: UPDATED },
};

// Native message rows: assistant turns carry tokens + cost + time.completed.
const MESSAGES: OcMessageRow[] = [
  {
    id: "msg_1",
    role: "user",
    time: { created: CREATED },
    model: { modelID: "claude-sonnet-4-5-20250929" },
    texts: ["fix the deploy script please"],
  },
  {
    id: "msg_2",
    role: "assistant",
    time: { created: CREATED + 500, completed: CREATED + 1000 },
    modelID: "claude-sonnet-4-5-20250929",
    cost: 0.046089,
    tokens: { input: 3, output: 27, reasoning: 0, cache: { read: 0, write: 12180 } },
    texts: ["looking into it now"],
  },
  {
    id: "msg_3",
    role: "assistant",
    // ~1h later → a distinct hour bucket.
    time: { created: CREATED + 3_600_000, completed: CREATED + 3_601_000 },
    modelID: "claude-sonnet-4-5-20250929",
    cost: 0.1,
    tokens: { input: 10, output: 40, reasoning: 0, cache: { read: 100, write: 200 } },
    texts: ["done"],
  },
];

describe("opencodeToImport (full adapter)", () => {
  test("builds a closed opencode session keyed by id", () => {
    const { session } = opencodeToImport(SESSION, MESSAGES);
    expect(session.provider).toBe("opencode");
    expect(session.sessionKey).toBe("ses_abc123");
    expect(session.state).toBe("closed");
  });

  test("resumeId undefined (opencode has no documented resume id)", () => {
    expect(opencodeToImport(SESSION, MESSAGES).session.resumeId).toBeUndefined();
  });

  test("cwd comes from session.directory; null when absent", () => {
    expect(opencodeToImport(SESSION, MESSAGES).session.cwd).toBe("/Users/me/Development/proj");
    expect(opencodeToImport({ ...SESSION, directory: undefined }, MESSAGES).session.cwd).toBeNull();
  });

  test("model derived from messages", () => {
    expect(opencodeToImport(SESSION, MESSAGES).session.model).toBe("claude-sonnet-4-5-20250929");
  });

  test("startedAt=created, endedAt=updated (ms), lastSeen=updated", () => {
    const { session } = opencodeToImport(SESSION, MESSAGES);
    expect(session.startedAt).toBe(CREATED);
    expect(session.endedAt).toBe(UPDATED);
    expect(session.lastSeenAt).toBe(UPDATED);
  });

  test("native tokens summed across assistant turns (NON-ZERO)", () => {
    const { session } = opencodeToImport(SESSION, MESSAGES);
    expect(session.tokensIn).toBe(13); // 3 + 10
    expect(session.tokensOut).toBe(67); // 27 + 40
    expect(session.tokensCacheRead).toBe(100); // 0 + 100
    expect(session.tokensCacheWrite).toBe(12380); // 12180 + 200
  });

  test("native per-message cost summed onto session.costUsd", () => {
    const { session } = opencodeToImport(SESSION, MESSAGES);
    expect(session.costUsd).toBeCloseTo(0.146089, 6); // 0.046089 + 0.1
  });

  test("hour-bucketed samples present (not empty), cumulative tokens ascend", () => {
    const { samples } = opencodeToImport(SESSION, MESSAGES);
    expect(samples.length).toBeGreaterThanOrEqual(2); // two distinct hour buckets
    expect(samples.every((s) => s.resolution === "hour")).toBe(true);
    // last bucket reflects the cumulative rollup
    const last = samples[samples.length - 1];
    expect(last.tokensIn).toBe(13);
    expect(last.tokensOut).toBe(67);
  });

  test("category is the provider default 'code' (resolver refines via cwd)", () => {
    expect(opencodeToImport(SESSION, MESSAGES).session.category).toBe("code");
  });

  test("subject best-effort from title; summary left undefined (Haiku fills)", () => {
    const { session } = opencodeToImport(SESSION, MESSAGES);
    expect(session.subject).toBeDefined();
    expect(session.summary).toBeUndefined();
  });

  test("events: session.started + session.closed (no errored when clean)", () => {
    const { events } = opencodeToImport(SESSION, MESSAGES);
    expect(events.find((e) => e.type === "session.started")).toBeDefined();
    expect(events.find((e) => e.type === "session.closed")).toBeDefined();
    expect(events.find((e) => e.type === "session.errored")).toBeUndefined();
  });

  test("a message error → session.errored bookend", () => {
    const withErr: OcMessageRow[] = [
      ...MESSAGES,
      {
        id: "msg_err",
        role: "assistant",
        time: { created: UPDATED, completed: UPDATED },
        modelID: "grok-code",
        cost: 0,
        tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        error: { name: "APIError" },
        texts: [],
      },
    ];
    const { events } = opencodeToImport(SESSION, withErr);
    expect(events.find((e) => e.type === "session.errored")).toBeDefined();
  });

  test("tool parts → session.tool events + toolsUsed (when present)", () => {
    const withTools: OcMessageRow[] = [
      MESSAGES[0],
      { ...MESSAGES[1], tools: ["bash", "read"] },
    ];
    const { session, events } = opencodeToImport(SESSION, withTools);
    expect(session.toolsUsed?.sort()).toEqual(["bash", "read"]);
    const tools = events.filter((e) => e.type === "session.tool").map((e) => (e.detail as any).tool);
    expect(tools.sort()).toEqual(["bash", "read"]);
  });

  // Graceful no-usage case: no tokens/cost → undefined cost + empty samples.
  test("no usable usage → costUsd undefined, samples empty, still closed", () => {
    const bare: OcMessageRow[] = [
      { id: "u1", role: "user", time: { created: CREATED }, texts: ["hi"] },
    ];
    const { session, samples } = opencodeToImport(SESSION, bare);
    expect(session.sessionKey).toBe("ses_abc123");
    expect(session.costUsd).toBeUndefined();
    expect(session.tokensIn).toBe(0);
    expect(samples).toEqual([]);
  });

  test("graceful on no messages at all", () => {
    const { session, samples, events } = opencodeToImport(SESSION, []);
    expect(session.sessionKey).toBe("ses_abc123");
    expect(samples).toEqual([]);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });
});

describe("opencodeBackfillAdapter.discover", () => {
  let home: string;
  let base: string;

  function writeJson(p: string, obj: unknown) {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(obj));
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "oc-bf-"));
    base = join(home, ".local", "share", "opencode", "storage");
    // session/<projectID>/<id>.json
    writeJson(join(base, "session", "global", `${SESSION.id}.json`), SESSION);
    // message/<sessionId>/*.json — user + assistant (with native usage)
    writeJson(join(base, "message", SESSION.id, "msg_1.json"), {
      id: "msg_1",
      sessionID: SESSION.id,
      role: "user",
      time: { created: CREATED },
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929" },
    });
    writeJson(join(base, "message", SESSION.id, "msg_2.json"), {
      id: "msg_2",
      sessionID: SESSION.id,
      role: "assistant",
      time: { created: CREATED + 500, completed: CREATED + 1000 },
      modelID: "claude-sonnet-4-5-20250929",
      cost: 0.046089,
      tokens: { input: 3, output: 27, reasoning: 0, cache: { read: 0, write: 12180 } },
    });
    // part/<messageId>/*.json — text parts
    writeJson(join(base, "part", "msg_1", "prt_1.json"), {
      id: "prt_1",
      messageID: "msg_1",
      type: "text",
      text: "fix the deploy script please",
    });
    writeJson(join(base, "part", "msg_2", "prt_2.json"), {
      id: "prt_2",
      messageID: "msg_2",
      type: "text",
      text: "looking into it now",
    });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("available() true when storage/session exists, false when absent", () => {
    expect(opencodeBackfillAdapter.available({ home })).toBe(true);
    const empty = mkdtempSync(join(tmpdir(), "oc-empty-"));
    expect(opencodeBackfillAdapter.available({ home: empty })).toBe(false);
    rmSync(empty, { recursive: true, force: true });
  });

  test("available() does not throw when storage absent", () => {
    expect(() => opencodeBackfillAdapter.available({ home: "/nonexistent/path/xyz" })).not.toThrow();
  });

  test("discover yields the session keyed by id with messages tied in", () => {
    const raws = [...opencodeBackfillAdapter.discover({ home })];
    expect(raws.length).toBe(1);
    expect(opencodeBackfillAdapter.sessionKey(raws[0])).toBe(SESSION.id);
  });

  test("toImport off a discovered row produces a full opencode session", () => {
    const raws = [...opencodeBackfillAdapter.discover({ home })];
    const { session, samples } = opencodeBackfillAdapter.toImport(raws[0]);
    expect(session.provider).toBe("opencode");
    expect(session.sessionKey).toBe(SESSION.id);
    expect(session.cwd).toBe(SESSION.directory);
    expect(session.model).toBe("claude-sonnet-4-5-20250929");
    // native usage flowed through the disk → row → import path
    expect(session.tokensIn).toBe(3);
    expect(session.tokensOut).toBe(27);
    expect(session.costUsd).toBeCloseTo(0.046089, 6);
    expect(samples.length).toBeGreaterThanOrEqual(1);
  });

  test("enrichInput returns a role-tagged tail", () => {
    const raws = [...opencodeBackfillAdapter.discover({ home })];
    const ti = opencodeBackfillAdapter.enrichInput!(raws[0]);
    expect(ti).toContain("user:");
    expect(ti.length).toBeGreaterThan(0);
  });
});
