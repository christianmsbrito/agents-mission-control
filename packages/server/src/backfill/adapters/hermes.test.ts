import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermesToImport, hermesBackfillAdapter, type HermesRow } from "./hermes.ts";

// started_at / ended_at are epoch SECONDS in hermes' db.
const STARTED_S = 1_750_000_000; // seconds
const ENDED_S = 1_750_003_600; // +1h, seconds

const CLI_ROW: HermesRow = {
  id: "sess-cli-1",
  source: "cli",
  model: "claude-sonnet-4-5",
  title: "Fix the deploy script",
  started_at: STARTED_S,
  ended_at: ENDED_S,
  input_tokens: 1000,
  output_tokens: 300,
  cache_read_tokens: 5000,
  cache_write_tokens: 200,
  estimated_cost_usd: 0,
  actual_cost_usd: 0,
};

const CRON_ROW: HermesRow = {
  id: "sess-cron-1",
  source: "cron",
  model: "claude-haiku-4-5",
  title: "Nightly summary",
  started_at: STARTED_S,
  ended_at: ENDED_S,
  input_tokens: 50,
  output_tokens: 20,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  estimated_cost_usd: 0,
  actual_cost_usd: 0,
};

const MESSAGES = [
  { role: "user", content: "fix the deploy script please", tool_name: null, timestamp: STARTED_S },
  { role: "assistant", content: "looking into it", tool_name: null, timestamp: STARTED_S + 10 },
  { role: "tool", content: "ran command", tool_name: "bash", timestamp: STARTED_S + 20 },
  { role: "tool", content: "read a file", tool_name: "read_file", timestamp: STARTED_S + 30 },
  { role: "tool", content: "ran again", tool_name: "bash", timestamp: STARTED_S + 40 },
];

describe("hermesToImport", () => {
  test("builds a closed hermes session keyed by id, cwd null, no samples", () => {
    const { session, samples } = hermesToImport(CLI_ROW, MESSAGES);
    expect(session.provider).toBe("hermes");
    expect(session.sessionKey).toBe("sess-cli-1");
    expect(session.state).toBe("closed");
    expect(session.cwd).toBeNull();
    expect(session.model).toBe("claude-sonnet-4-5");
    // hermes has no per-turn time-series.
    expect(samples).toEqual([]);
  });

  test("converts epoch seconds to ms for started/ended/lastSeen", () => {
    const { session } = hermesToImport(CLI_ROW, MESSAGES);
    expect(session.startedAt).toBe(STARTED_S * 1000);
    expect(session.endedAt).toBe(ENDED_S * 1000);
    expect(session.lastSeenAt).toBe(ENDED_S * 1000);
  });

  test("missing ended_at falls back to started_at (still ms)", () => {
    const { session } = hermesToImport({ ...CLI_ROW, ended_at: undefined }, MESSAGES);
    expect(session.endedAt).toBe(STARTED_S * 1000);
  });

  test("tokens come from the sessions row; costUsd undefined (orchestrator estimates)", () => {
    const { session } = hermesToImport(CLI_ROW, MESSAGES);
    expect(session.tokensIn).toBe(1000);
    expect(session.tokensOut).toBe(300);
    expect(session.tokensCacheRead).toBe(5000);
    expect(session.tokensCacheWrite).toBe(200);
    expect(session.costUsd).toBeUndefined();
  });

  test("category maps from source: cli -> personal", () => {
    expect(hermesToImport(CLI_ROW, MESSAGES).session.category).toBe("personal");
  });

  test("category maps from source: cron -> infra, telegram -> personal, curator -> research", () => {
    expect(hermesToImport({ ...CLI_ROW, source: "cron" }, MESSAGES).session.category).toBe("infra");
    expect(hermesToImport({ ...CLI_ROW, source: "telegram" }, MESSAGES).session.category).toBe(
      "personal",
    );
    expect(hermesToImport({ ...CLI_ROW, source: "curator" }, MESSAGES).session.category).toBe(
      "research",
    );
  });

  test("resumeId set only for cli source (else undefined → disabled resume)", () => {
    expect(hermesToImport(CLI_ROW, MESSAGES).session.resumeId).toBe("sess-cli-1");
    expect(hermesToImport(CRON_ROW, MESSAGES).session.resumeId).toBeUndefined();
    expect(hermesToImport({ ...CLI_ROW, source: "telegram" }, MESSAGES).session.resumeId).toBeUndefined();
  });

  test("subject from title; summary left undefined (Haiku fills it)", () => {
    const { session } = hermesToImport(CLI_ROW, MESSAGES);
    expect(session.subject).toBeDefined();
    expect(session.summary).toBeUndefined();
  });

  test("events: started + closed + one session.tool per distinct tool_name", () => {
    const { events } = hermesToImport(CLI_ROW, MESSAGES);
    expect(events.find((e) => e.type === "session.started")).toBeDefined();
    expect(events.find((e) => e.type === "session.closed")).toBeDefined();
    const tools = events.filter((e) => e.type === "session.tool").map((e) => (e.detail as any).tool);
    expect(tools.sort()).toEqual(["bash", "read_file"]); // distinct
  });
});

describe("hermesBackfillAdapter.discover", () => {
  let dir: string;
  let dbPath: string;

  function seedDb(p: string) {
    const db = new Database(p);
    db.run(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, started_at INTEGER, ended_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL)",
    );
    db.run(
      "CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, tool_name TEXT, timestamp INTEGER)",
    );
    const ins = db.prepare(
      "INSERT INTO sessions (id, source, model, title, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, actual_cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const r of [CLI_ROW, CRON_ROW]) {
      ins.run(
        r.id,
        r.source,
        r.model ?? null,
        r.title ?? null,
        r.started_at,
        r.ended_at ?? null,
        r.input_tokens ?? 0,
        r.output_tokens ?? 0,
        r.cache_read_tokens ?? 0,
        r.cache_write_tokens ?? 0,
        r.estimated_cost_usd ?? 0,
        r.actual_cost_usd ?? 0,
      );
    }
    const insM = db.prepare(
      "INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?,?,?,?,?)",
    );
    for (const m of MESSAGES) insM.run("sess-cli-1", m.role, m.content, m.tool_name, m.timestamp);
    db.close();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hermes-bf-"));
    mkdirSync(join(dir, ".hermes"), { recursive: true });
    dbPath = join(dir, ".hermes", "state.db");
    seedDb(dbPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("available() true when state.db exists, false when absent", () => {
    expect(hermesBackfillAdapter.available({ home: dir })).toBe(true);
    const empty = mkdtempSync(join(tmpdir(), "hermes-empty-"));
    expect(hermesBackfillAdapter.available({ home: empty })).toBe(false);
    rmSync(empty, { recursive: true, force: true });
  });

  test("default opts exclude cron rows", () => {
    const ids = [...hermesBackfillAdapter.discover({ home: dir })].map((r) =>
      hermesBackfillAdapter.sessionKey(r),
    );
    expect(ids).toContain("sess-cli-1");
    expect(ids).not.toContain("sess-cron-1");
  });

  test("includeHermesCron yields cron rows too", () => {
    const ids = [...hermesBackfillAdapter.discover({ home: dir, includeHermesCron: true })].map((r) =>
      hermesBackfillAdapter.sessionKey(r),
    );
    expect(ids).toContain("sess-cli-1");
    expect(ids).toContain("sess-cron-1");
  });

  test("toImport off a discovered row produces a hermes session with messages tools", () => {
    const raw = [...hermesBackfillAdapter.discover({ home: dir })][0];
    const { session, events } = hermesBackfillAdapter.toImport(raw);
    expect(session.provider).toBe("hermes");
    expect(session.sessionKey).toBe("sess-cli-1");
    const tools = events.filter((e) => e.type === "session.tool").map((e) => (e.detail as any).tool);
    expect(tools.sort()).toEqual(["bash", "read_file"]);
  });

  test("enrichInput returns a role-tagged tail", () => {
    const raw = [...hermesBackfillAdapter.discover({ home: dir })][0];
    const ti = hermesBackfillAdapter.enrichInput!(raw);
    expect(ti).toContain("user:");
    expect(ti.length).toBeGreaterThan(0);
  });
});
