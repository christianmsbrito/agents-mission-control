import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { Store, sessionKeyOf, hourBucket, dayBucket, condenseSamples } from "./store.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe("sessionKeyOf", () => {
  test("prefers providerSessionId", () => {
    expect(sessionKeyOf({ providerSessionId: "P9", hostId: "h", pid: 5, startedAt: 1 } as any)).toBe("P9");
  });
  test("synthesizes when no providerSessionId (startedAt floored to seconds)", () => {
    // startedAt 1ms floors to second 0 -> "h:5:0".
    expect(sessionKeyOf({ hostId: "h", pid: 5, startedAt: 1 } as any)).toBe("h:5:0");
  });
  test("synthetic key is stable under sub-second startedAt jitter", () => {
    // Two ticks of the SAME daemon session whose startedAt wobbles <1000ms
    // (uptimeSec floored to whole sec vs continuous `now`) must map to ONE key.
    const a = sessionKeyOf({ hostId: "h", pid: 5, startedAt: 1_699_999_100 } as any);
    const b = sessionKeyOf({ hostId: "h", pid: 5, startedAt: 1_699_999_812 } as any);
    expect(a).toBe(b);
    expect(a).toBe("h:5:1699999"); // floor(1699999xxx / 1000)
  });
  test("provider-native id still wins over the synthetic floor", () => {
    expect(
      sessionKeyOf({ providerSessionId: "P9", hostId: "h", pid: 5, startedAt: 1_699_999_812 } as any),
    ).toBe("P9");
  });
});

describe("Store.record registry", () => {
  test("returns sessions that closed since the previous tick (for troop.closed)", () => {
    const store = new Store(":memory:");
    const s = { id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H",
      cwd: "/r", category: "code", startedAt: 1000, cpu: 0, memMb: 0, providerSessionId: "P9", templateId: "feat" };
    expect(store.record({ hostId: "h", hostLabel: "H", sentAt: 1000, sessions: [s] } as any, 1000).closed).toEqual([]);
    const out = store.record({ hostId: "h", hostLabel: "H", sentAt: 2000, sessions: [] } as any, 2000);
    expect(out.closed.length).toBe(1);
    expect(out.closed[0]!.templateId).toBe("feat");
    expect(out.closed[0]!.id).toBe("h:5");
    store.close();
  });

  test("inserts a running session and updates rollups across ticks", () => {
    const store = new Store(":memory:");
    const base = { id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H",
      cwd: "/r", category: "code", startedAt: 1000, cpu: 0, memMb: 0, providerSessionId: "P9" };
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1000,
      sessions: [{ ...base, costUsd: 0.1, tokensOut: 10, toolsUsed: ["bash"] }] } as any, 1000);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 2000,
      sessions: [{ ...base, costUsd: 0.3, tokensOut: 40, toolsUsed: ["bash", "edit"] }] } as any, 2000);
    const row: any = store.db.query("SELECT * FROM sessions WHERE session_key='P9'").get();
    expect(row.state).toBe("running");
    expect(row.cost_usd).toBe(0.3);
    expect(JSON.parse(row.tools_used).sort()).toEqual(["bash", "edit"]);
    expect(row.last_seen_at).toBe(2000);
    store.close();
  });

  test("daemon session (no providerSessionId) stays ONE row under startedAt jitter", () => {
    const store = new Store(":memory:");
    // Same logical hermes daemon, reported across 3 ticks. startedAt = now - uptimeSec*1000
    // jitters by a few hundred ms each tick (uptimeSec floored to whole sec). The synthetic
    // key must collapse all variants to one row.
    const mk = (startedAt: number) => ({
      id: "h:42", provider: "hermes", pid: 42, hostId: "h", hostLabel: "H",
      cwd: "/r", category: "code", startedAt, cpu: 0, memMb: 0, // NO providerSessionId
    });
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1000, sessions: [mk(123_400)] } as any, 1000);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 4000, sessions: [mk(123_750)] } as any, 4000);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 7000, sessions: [mk(123_010)] } as any, 7000);
    const count: any = store.db.query("SELECT COUNT(*) c FROM sessions").get();
    expect(count.c).toBe(1);
    store.close();
  });
});

describe("Store.record events", () => {
  const base = { id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H",
    cwd: "/r", category: "code", startedAt: 1, cpu: 0, memMb: 0, providerSessionId: "P9" };

  test("started then closed across ticks", () => {
    const store = new Store(":memory:");
    const s = { id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H",
      cwd: "/r", category: "code", startedAt: 1, cpu: 0, memMb: 0, providerSessionId: "P9" };
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1, sessions: [s] } as any, 1);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 2, sessions: [] } as any, 2);
    const types = store.db.query("SELECT type FROM events ORDER BY id").all().map((r: any) => r.type);
    expect(types).toEqual(["session.started", "session.closed"]);
    const row: any = store.db.query("SELECT state, ended_at FROM sessions WHERE session_key='P9'").get();
    expect(row.state).toBe("closed");
    expect(row.ended_at).toBe(2);
    store.close();
  });

  test("active false->true flip emits session.state with {from,to}", () => {
    const store = new Store(":memory:");
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1,
      sessions: [{ ...base, active: false }] } as any, 1);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 2,
      sessions: [{ ...base, active: true }] } as any, 2);
    const ev: any = store.db.query("SELECT type, detail FROM events WHERE type='session.state'").get();
    expect(ev.type).toBe("session.state");
    expect(JSON.parse(ev.detail)).toEqual({ field: "active", from: false, to: true });
    store.close();
  });

  test("attention false->true flip emits session.state with {field,from,to}", () => {
    const store = new Store(":memory:");
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1,
      sessions: [{ ...base, attention: false }] } as any, 1);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 2,
      sessions: [{ ...base, attention: true }] } as any, 2);
    const ev: any = store.db.query("SELECT type, detail FROM events WHERE type='session.state'").get();
    expect(ev.type).toBe("session.state");
    expect(JSON.parse(ev.detail)).toEqual({ field: "attention", from: false, to: true });
    store.close();
  });

  test("new tool in toolsUsed emits session.tool with {tool}", () => {
    const store = new Store(":memory:");
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1,
      sessions: [{ ...base, toolsUsed: ["bash"] }] } as any, 1);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 2,
      sessions: [{ ...base, toolsUsed: ["bash", "edit"] }] } as any, 2);
    const evs = store.db.query("SELECT type, detail FROM events WHERE type='session.tool' ORDER BY id").all() as any[];
    expect(evs.length).toBe(1);
    expect(JSON.parse(evs[0].detail)).toEqual({ tool: "edit" });
    store.close();
  });

  test("errored flip emits session.errored", () => {
    const store = new Store(":memory:");
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1,
      sessions: [{ ...base, errored: false }] } as any, 1);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 2,
      sessions: [{ ...base, errored: true, errorTransient: true }] } as any, 2);
    const ev: any = store.db.query("SELECT type, detail FROM events WHERE type='session.errored'").get();
    expect(ev.type).toBe("session.errored");
    expect(JSON.parse(ev.detail)).toEqual({ from: false, to: true, transient: true });
    store.close();
  });

  test("errored flip without errorTransient yields transient: null", () => {
    const store = new Store(":memory:");
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1,
      sessions: [{ ...base, errored: false }] } as any, 1);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 2,
      sessions: [{ ...base, errored: true }] } as any, 2);
    const ev: any = store.db.query("SELECT detail FROM events WHERE type='session.errored'").get();
    expect(JSON.parse(ev.detail)).toEqual({ from: false, to: true, transient: null });
    store.close();
  });

  test("a second host's report does not close the first host's sessions", () => {
    const store = new Store(":memory:");
    const a = { ...base, id: "ha:1", pid: 1, hostId: "ha", hostLabel: "HA", providerSessionId: "PA" };
    const b = { ...base, id: "hb:2", pid: 2, hostId: "hb", hostLabel: "HB", providerSessionId: "PB" };
    store.record({ hostId: "ha", hostLabel: "HA", sentAt: 1, sessions: [a] } as any, 1);
    store.record({ hostId: "hb", hostLabel: "HB", sentAt: 2, sessions: [b] } as any, 2);
    const closed = store.db.query("SELECT session_key FROM events WHERE type='session.closed'").all();
    expect(closed.length).toBe(0);
    const rowA: any = store.db.query("SELECT state FROM sessions WHERE session_key='PA'").get();
    expect(rowA.state).toBe("running");
    store.close();
  });
});

describe("Store sample gate", () => {
  test("sample gate throttles per session", () => {
    const store = new Store(":memory:", { sampleIntervalMs: 60_000 } as any);
    const s = (t: number) => ({ id: "h:5", provider: "claude", pid: 5, hostId: "h",
      hostLabel: "H", cwd: "/r", category: "code", startedAt: 1, cpu: 1, memMb: 2,
      providerSessionId: "P9", costUsd: 0.1, active: true });
    store.record({ hostId: "h", hostLabel: "H", sentAt: 0, sessions: [s(0)] } as any, 0);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 30_000, sessions: [s(30_000)] } as any, 30_000);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 60_000, sessions: [s(60_000)] } as any, 60_000);
    const n = store.db.query("SELECT COUNT(*) c FROM samples WHERE resolution='raw'").get() as any;
    expect(n.c).toBe(2);
    store.close();
  });

  test("raw sample row carries expected columns", () => {
    const store = new Store(":memory:", { sampleIntervalMs: 60_000 } as any);
    const s = {
      id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H", cwd: "/r",
      category: "code", startedAt: 1, cpu: 1.5, memMb: 2.5, providerSessionId: "P9",
      costUsd: 0.1, tokensIn: 100, tokensOut: 200, tokensCacheRead: 300,
      tokensCacheWrite: 400, contextTokens: 500, contextWindow: 600, active: false,
    };
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1234, sessions: [s] } as any, 1234);
    const row: any = store.db.query("SELECT * FROM samples WHERE resolution='raw'").get();
    expect(row.session_key).toBe("P9");
    expect(row.at).toBe(1234);
    expect(row.resolution).toBe("raw");
    expect(row.cost_usd).toBe(0.1);
    expect(row.tokens_in).toBe(100);
    expect(row.tokens_out).toBe(200);
    expect(row.tokens_cache_read).toBe(300);
    expect(row.tokens_cache_write).toBe(400);
    expect(row.context_tokens).toBe(500);
    expect(row.context_window).toBe(600);
    expect(row.cpu).toBe(1.5);
    expect(row.mem_mb).toBe(2.5);
    expect(row.active).toBe(0);
    store.close();
  });

  test("active true maps to 1 and missing numerics to null", () => {
    const store = new Store(":memory:", { sampleIntervalMs: 60_000 } as any);
    const s = { id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H",
      cwd: "/r", category: "code", startedAt: 1, cpu: 0, memMb: 0,
      providerSessionId: "P9", active: true };
    store.record({ hostId: "h", hostLabel: "H", sentAt: 0, sessions: [s] } as any, 0);
    const row: any = store.db.query("SELECT * FROM samples WHERE resolution='raw'").get();
    expect(row.active).toBe(1);
    expect(row.cost_usd).toBe(null);
    expect(row.tokens_in).toBe(null);
    expect(row.context_tokens).toBe(null);
    store.close();
  });
});

describe("Store.onHostOffline", () => {
  const base = { id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H",
    cwd: "/r", category: "code", startedAt: 1, cpu: 0, memMb: 0, providerSessionId: "P9" };

  test("orphans a running session: state='orphaned', ended_at NULL, last_seen_at updated", () => {
    const store = new Store(":memory:");
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1, sessions: [base] } as any, 1);
    store.onHostOffline("h", 5000);
    const row: any = store.db.query("SELECT state, ended_at, last_seen_at FROM sessions WHERE session_key='P9'").get();
    expect(row.state).toBe("orphaned");
    expect(row.ended_at).toBe(null);
    expect(row.last_seen_at).toBe(5000);
    store.close();
  });

  test("a subsequent record() revives the session back to 'running'", () => {
    const store = new Store(":memory:");
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1, sessions: [base] } as any, 1);
    store.onHostOffline("h", 5000);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 6000, sessions: [base] } as any, 6000);
    const row: any = store.db.query("SELECT state, ended_at FROM sessions WHERE session_key='P9'").get();
    expect(row.state).toBe("running");
    expect(row.ended_at).toBe(null);
    store.close();
  });

  test("does not revive or touch a session already state='closed'", () => {
    const store = new Store(":memory:");
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1, sessions: [base] } as any, 1);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 2, sessions: [] } as any, 2);
    const before: any = store.db.query("SELECT state, ended_at, last_seen_at FROM sessions WHERE session_key='P9'").get();
    expect(before.state).toBe("closed");
    store.onHostOffline("h", 5000);
    const after: any = store.db.query("SELECT state, ended_at, last_seen_at FROM sessions WHERE session_key='P9'").get();
    expect(after.state).toBe("closed");
    expect(after.ended_at).toBe(before.ended_at);
    expect(after.last_seen_at).toBe(before.last_seen_at);
    store.close();
  });

  test("orphaning one host does not affect another host's sessions", () => {
    const store = new Store(":memory:");
    const a = { ...base, id: "ha:1", pid: 1, hostId: "ha", hostLabel: "HA", providerSessionId: "PA" };
    const b = { ...base, id: "hb:2", pid: 2, hostId: "hb", hostLabel: "HB", providerSessionId: "PB" };
    store.record({ hostId: "ha", hostLabel: "HA", sentAt: 1, sessions: [a] } as any, 1);
    store.record({ hostId: "hb", hostLabel: "HB", sentAt: 1, sessions: [b] } as any, 1);
    store.onHostOffline("ha", 5000);
    const rowA: any = store.db.query("SELECT state FROM sessions WHERE session_key='PA'").get();
    const rowB: any = store.db.query("SELECT state, last_seen_at FROM sessions WHERE session_key='PB'").get();
    expect(rowA.state).toBe("orphaned");
    expect(rowB.state).toBe("running");
    expect(rowB.last_seen_at).toBe(1);
    store.close();
  });
});

describe("Store.compact orphan reconcile", () => {
  const DAY = 86_400_000;
  const base = { id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H",
    cwd: "/r", category: "code", startedAt: 1, cpu: 0, memMb: 0, providerSessionId: "P9" };

  test("a stale orphaned session (older than orphanCloseDays) reconciles to closed with ended_at=last_seen_at", () => {
    const store = new Store(":memory:");
    const lastSeen = 1_000_000;
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1, sessions: [base] } as any, lastSeen);
    store.onHostOffline("h", lastSeen);
    // default orphanCloseDays is 7; compact 8 days later
    store.compact(lastSeen + 8 * DAY);
    const row: any = store.db.query("SELECT state, ended_at, last_seen_at FROM sessions WHERE session_key='P9'").get();
    expect(row.state).toBe("closed");
    expect(row.ended_at).toBe(lastSeen);
    expect(row.last_seen_at).toBe(lastSeen);
    store.close();
  });

  test("a recently-orphaned session (within orphanCloseDays) is NOT reconciled", () => {
    const store = new Store(":memory:");
    const lastSeen = 1_000_000;
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1, sessions: [base] } as any, lastSeen);
    store.onHostOffline("h", lastSeen);
    store.compact(lastSeen + 3 * DAY); // < 7 days
    const row: any = store.db.query("SELECT state, ended_at FROM sessions WHERE session_key='P9'").get();
    expect(row.state).toBe("orphaned");
    expect(row.ended_at).toBe(null);
    store.close();
  });

  test("running and already-closed sessions are untouched by the reconcile", () => {
    const store = new Store(":memory:");
    const running = { ...base, id: "h:5", pid: 5, providerSessionId: "PR" };
    const closing = { ...base, id: "h:6", pid: 6, providerSessionId: "PC" };
    const lastSeen = 1_000_000;
    // running stays present
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1, sessions: [running, closing] } as any, lastSeen);
    // closing disappears -> closed at lastSeen+1
    store.record({ hostId: "h", hostLabel: "H", sentAt: 2, sessions: [running] } as any, lastSeen + 1);
    store.compact(lastSeen + 30 * DAY);
    const r: any = store.db.query("SELECT state, ended_at FROM sessions WHERE session_key='PR'").get();
    const c: any = store.db.query("SELECT state, ended_at FROM sessions WHERE session_key='PC'").get();
    expect(r.state).toBe("running");
    expect(r.ended_at).toBe(null);
    expect(c.state).toBe("closed");
    expect(c.ended_at).toBe(lastSeen + 1);
    store.close();
  });

  test("default orphanCloseDays is 7", () => {
    const store = new Store(":memory:");
    expect(store.retentionConfig.orphanCloseDays).toBe(7);
    store.close();
  });

  test("setRetention({ orphanCloseDays: 1 }) takes effect", () => {
    const store = new Store(":memory:");
    const lastSeen = 1_000_000;
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1, sessions: [base] } as any, lastSeen);
    store.onHostOffline("h", lastSeen);
    store.setRetention({ orphanCloseDays: 1 });
    // 2 days later: within default-7 window but past the new 1-day window
    store.compact(lastSeen + 2 * DAY);
    const row: any = store.db.query("SELECT state, ended_at FROM sessions WHERE session_key='P9'").get();
    expect(row.state).toBe("closed");
    expect(row.ended_at).toBe(lastSeen);
    store.close();
  });
});

describe("Store schema", () => {
  test("opens :memory: and creates the three tables", () => {
    const store = new Store(":memory:");
    const tables = store.db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["events", "samples", "sessions"]));
    store.close();
  });
});

describe("hourBucket / dayBucket", () => {
  test("hourBucket floors to start of UTC hour", () => {
    // 2021-01-01T12:34:56.789Z
    const t = Date.UTC(2021, 0, 1, 12, 34, 56, 789);
    expect(hourBucket(t)).toBe(Date.UTC(2021, 0, 1, 12, 0, 0, 0));
  });
  test("hourBucket on an exact hour boundary is identity", () => {
    const t = Date.UTC(2021, 0, 1, 12, 0, 0, 0);
    expect(hourBucket(t)).toBe(t);
  });
  test("dayBucket floors to start of UTC day", () => {
    const t = Date.UTC(2021, 0, 1, 12, 34, 56, 789);
    expect(dayBucket(t)).toBe(Date.UTC(2021, 0, 1, 0, 0, 0, 0));
  });
  test("dayBucket on an exact day boundary is identity", () => {
    const t = Date.UTC(2021, 0, 1, 0, 0, 0, 0);
    expect(dayBucket(t)).toBe(t);
  });
});

describe("condenseSamples", () => {
  test("cumulative=last, gauges=avg, window=last, active=fraction", () => {
    const rows = [
      { at: 100, cost_usd: 0.1, tokens_in: 10, tokens_out: 1, tokens_cache_read: 2,
        tokens_cache_write: 3, context_tokens: 100, context_window: 1000, cpu: 10, mem_mb: 50, active: 1 },
      { at: 300, cost_usd: 0.3, tokens_in: 30, tokens_out: 3, tokens_cache_read: 6,
        tokens_cache_write: 9, context_tokens: 300, context_window: 2000, cpu: 30, mem_mb: 150, active: 0 },
      { at: 200, cost_usd: 0.2, tokens_in: 20, tokens_out: 2, tokens_cache_read: 4,
        tokens_cache_write: 6, context_tokens: 200, context_window: 1500, cpu: 20, mem_mb: 100, active: 0 },
    ];
    const c = condenseSamples(rows);
    // cumulative fields = last (max at = 300)
    expect(c.cost_usd).toBe(0.3);
    expect(c.tokens_in).toBe(30);
    expect(c.tokens_out).toBe(3);
    expect(c.tokens_cache_read).toBe(6);
    expect(c.tokens_cache_write).toBe(9);
    // gauges = average
    expect(c.context_tokens).toBe(200);
    expect(c.cpu).toBe(20);
    expect(c.mem_mb).toBe(100);
    // context_window = last
    expect(c.context_window).toBe(2000);
    // active = fraction of rows with active>0 (1 of 3)
    expect(c.active).toBeCloseTo(1 / 3, 10);
  });
});

describe("Store.compact age ladder", () => {
  const NOW = Date.UTC(2026, 0, 100); // arbitrary stable now

  function seedSample(store: Store, key: string, at: number, resolution: string, vals: any) {
    store.db.query(
      `INSERT INTO samples (session_key, at, resolution, tokens_in, tokens_out,
        tokens_cache_read, tokens_cache_write, cost_usd, context_tokens,
        context_window, cpu, mem_mb, active)
       VALUES ($k,$at,$res,$ti,$to,$tcr,$tcw,$cost,$ctx,$cw,$cpu,$mem,$active)`,
    ).run({
      $k: key, $at: at, $res: resolution,
      $ti: vals.tokens_in ?? null, $to: vals.tokens_out ?? null,
      $tcr: vals.tokens_cache_read ?? null, $tcw: vals.tokens_cache_write ?? null,
      $cost: vals.cost_usd ?? null, $ctx: vals.context_tokens ?? null,
      $cw: vals.context_window ?? null, $cpu: vals.cpu ?? null,
      $mem: vals.mem_mb ?? null, $active: vals.active ?? 0,
    });
  }

  test("raw older than rawDays collapses to one hour row per (key, hour)", () => {
    const store = new Store(":memory:", { retention: { rawDays: 15 } });
    const old = NOW - 20 * DAY; // older than rawDays
    const h = hourBucket(old);
    // two raw rows in the same hour bucket for the same session
    seedSample(store, "S1", h + 60_000, "raw", { cost_usd: 0.1, context_tokens: 100, cpu: 10, mem_mb: 50, context_window: 1000, active: 1 });
    seedSample(store, "S1", h + 120_000, "raw", { cost_usd: 0.5, context_tokens: 300, cpu: 30, mem_mb: 150, context_window: 1000, active: 0 });
    // one raw row in a different hour bucket
    seedSample(store, "S1", h + HOUR + 60_000, "raw", { cost_usd: 0.9, context_tokens: 400, cpu: 40, mem_mb: 200, context_window: 1000, active: 1 });

    store.compact(NOW);

    const raw = store.db.query("SELECT COUNT(*) c FROM samples WHERE resolution='raw'").get() as any;
    expect(raw.c).toBe(0);
    const hours = store.db.query("SELECT * FROM samples WHERE resolution='hour' ORDER BY at").all() as any[];
    expect(hours.length).toBe(2);
    expect(hours[0].at).toBe(h);
    expect(hours[0].cost_usd).toBe(0.5); // last cumulative
    expect(hours[0].context_tokens).toBe(200); // avg of 100,300
    expect(hours[0].active).toBeCloseTo(0.5, 10); // 1 of 2 active
    expect(hours[1].at).toBe(h + HOUR);
    expect(hours[1].cost_usd).toBe(0.9);
    store.close();
  });

  test("recent raw samples (within rawDays) are left as raw", () => {
    const store = new Store(":memory:", { retention: { rawDays: 15 } });
    const recent = NOW - 1 * DAY;
    seedSample(store, "S1", recent, "raw", { cost_usd: 0.1 });
    store.compact(NOW);
    const raw = store.db.query("SELECT COUNT(*) c FROM samples WHERE resolution='raw'").get() as any;
    expect(raw.c).toBe(1);
    const hours = store.db.query("SELECT COUNT(*) c FROM samples WHERE resolution='hour'").get() as any;
    expect(hours.c).toBe(0);
    store.close();
  });

  test("hour rows older than hourDays promote to day", () => {
    const store = new Store(":memory:", { retention: { rawDays: 15, hourDays: 90 } });
    const old = NOW - 100 * DAY; // older than hourDays
    const d = dayBucket(old);
    seedSample(store, "S1", d + HOUR, "hour", { cost_usd: 0.2, context_tokens: 100, cpu: 10, mem_mb: 50, context_window: 1000, active: 1 });
    seedSample(store, "S1", d + 2 * HOUR, "hour", { cost_usd: 0.6, context_tokens: 300, cpu: 30, mem_mb: 150, context_window: 1000, active: 1 });
    store.compact(NOW);
    const hours = store.db.query("SELECT COUNT(*) c FROM samples WHERE resolution='hour'").get() as any;
    expect(hours.c).toBe(0);
    const days = store.db.query("SELECT * FROM samples WHERE resolution='day'").all() as any[];
    expect(days.length).toBe(1);
    expect(days[0].at).toBe(d);
    expect(days[0].cost_usd).toBe(0.6); // last
    expect(days[0].active).toBeCloseTo(1, 10);
    store.close();
  });

  test("events older than eventDays are hard-deleted; newer kept", () => {
    const store = new Store(":memory:", { retention: { eventDays: 90 } });
    store.db.query("INSERT INTO events (at, session_key, type) VALUES (?,?,?)")
      .run(NOW - 100 * DAY, "S1", "session.started");
    store.db.query("INSERT INTO events (at, session_key, type) VALUES (?,?,?)")
      .run(NOW - 1 * DAY, "S1", "session.closed");
    store.compact(NOW);
    const evs = store.db.query("SELECT type FROM events").all() as any[];
    expect(evs.length).toBe(1);
    expect(evs[0].type).toBe("session.closed");
    store.close();
  });

  test("compact never deletes or alters registry session rows", () => {
    const store = new Store(":memory:", { retention: { rawDays: 15 } });
    const base = { id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H",
      cwd: "/r", category: "code", startedAt: 1, cpu: 0, memMb: 0, providerSessionId: "P9" };
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1, sessions: [base] } as any, 1);
    const before: any = store.db.query("SELECT * FROM sessions WHERE session_key='P9'").get();
    store.compact(NOW);
    const after: any = store.db.query("SELECT * FROM sessions WHERE session_key='P9'").get();
    expect(after).toEqual(before);
    store.close();
  });
});

describe("Store.compact size ceiling", () => {
  function seedRaw(store: Store, key: string, at: number) {
    store.db.query(
      `INSERT INTO samples (session_key, at, resolution, cost_usd, context_tokens, context_window, cpu, mem_mb, active)
       VALUES (?,?, 'raw', ?, ?, ?, ?, ?, ?)`,
    ).run(key, at, 0.1, 100, 1000, 10, 50, 1);
  }

  test("preempts age ladder for oldest raw bucket under tiny maxBytes and warns", () => {
    const NOW = Date.UTC(2026, 0, 100);
    const store = new Store(":memory:", { retention: { rawDays: 15, maxBytes: 1 } });
    // recent raw rows (within rawDays), so age ladder won't touch them
    const baseHour = hourBucket(NOW - 1 * DAY);
    for (let i = 0; i < 50; i++) seedRaw(store, "S1", baseHour + i * 60_000);
    // a second, even older (but still within rawDays) hour bucket
    const olderHour = hourBucket(NOW - 2 * DAY);
    for (let i = 0; i < 50; i++) seedRaw(store, "S1", olderHour + i * 60_000);

    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: any[]) => warnings.push(a.join(" "));
    try {
      const res = store.compact(NOW);
      expect(res.sizePreempted).toBe(true);
    } finally {
      console.warn = orig;
    }
    expect(warnings.length).toBeGreaterThan(0);
    // some raw rows were promoted early to hour
    const hours = store.db.query("SELECT COUNT(*) c FROM samples WHERE resolution='hour'").get() as any;
    expect(hours.c).toBeGreaterThan(0);
    store.close();
  });

  test("no preempt under generous maxBytes", () => {
    const NOW = Date.UTC(2026, 0, 100);
    const store = new Store(":memory:", { retention: { rawDays: 15, maxBytes: 500_000_000 } });
    const baseHour = hourBucket(NOW - 1 * DAY);
    for (let i = 0; i < 10; i++) seedRaw(store, "S1", baseHour + i * 60_000);
    const res = store.compact(NOW);
    expect(res.sizePreempted).toBe(false);
    const raw = store.db.query("SELECT COUNT(*) c FROM samples WHERE resolution='raw'").get() as any;
    expect(raw.c).toBe(10);
    store.close();
  });
});

describe("Store.listSessions", () => {
  function seed(store: Store, over: any, at: number, sentAt = at) {
    const base = { id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H",
      cwd: "/r", category: "code", startedAt: at, cpu: 0, memMb: 0 };
    const s = { ...base, ...over };
    store.record({ hostId: s.hostId, hostLabel: s.hostLabel, sentAt, sessions: [s] } as any, sentAt);
    return s;
  }

  test("returns newest-first by started_at and maps to camelCase", () => {
    const store = new Store(":memory:");
    seed(store, { providerSessionId: "A", startedAt: 1000, costUsd: 0.5, tokensIn: 10,
      toolsUsed: ["bash"], model: "claude-3", handle: "mc:a1", hostId: "ha", hostLabel: "HA" }, 1000);
    seed(store, { providerSessionId: "B", startedAt: 3000, hostId: "hb", hostLabel: "HB" }, 3000);
    seed(store, { providerSessionId: "C", startedAt: 2000, hostId: "hc", hostLabel: "HC" }, 2000);
    const rows = store.listSessions();
    expect(rows.map((r) => r.sessionKey)).toEqual(["B", "C", "A"]);
    const a = rows.find((r) => r.sessionKey === "A")!;
    expect(a.costUsd).toBe(0.5);
    expect(a.tokensIn).toBe(10);
    expect(a.toolsUsed).toEqual(["bash"]);
    expect(a.model).toBe("claude-3");
    expect(a.handle).toBe("mc:a1");
    expect(a.state).toBe("running");
    expect(a.liveId).toBe("h:5");
    store.close();
  });

  test("filters by state, provider, cwd", () => {
    const store = new Store(":memory:");
    seed(store, { providerSessionId: "A", startedAt: 1000, provider: "claude", cwd: "/x", hostId: "ha", hostLabel: "HA" }, 1000);
    seed(store, { providerSessionId: "B", startedAt: 2000, provider: "codex", cwd: "/y", hostId: "hb", hostLabel: "HB" }, 2000);
    // close A by reporting an empty list for host ha at a later tick
    store.record({ hostId: "ha", hostLabel: "HA", sentAt: 3000, sessions: [] } as any, 3000);
    expect(store.listSessions({ state: "closed" }).map((r) => r.sessionKey)).toEqual(["A"]);
    expect(store.listSessions({ state: "running" }).map((r) => r.sessionKey)).toEqual(["B"]);
    expect(store.listSessions({ provider: "codex" }).map((r) => r.sessionKey)).toEqual(["B"]);
    expect(store.listSessions({ cwd: "/y" }).map((r) => r.sessionKey)).toEqual(["B"]);
    store.close();
  });

  test("filters by since/until on started_at", () => {
    const store = new Store(":memory:");
    seed(store, { providerSessionId: "A", startedAt: 1000 }, 1000);
    seed(store, { providerSessionId: "B", startedAt: 2000 }, 2000);
    seed(store, { providerSessionId: "C", startedAt: 3000 }, 3000);
    expect(store.listSessions({ since: 2000 }).map((r) => r.sessionKey)).toEqual(["C", "B"]);
    expect(store.listSessions({ until: 2000 }).map((r) => r.sessionKey)).toEqual(["B", "A"]);
    store.close();
  });

  test("respects limit and offset", () => {
    const store = new Store(":memory:");
    for (let i = 1; i <= 5; i++) seed(store, { providerSessionId: `S${i}`, startedAt: i * 1000 }, i * 1000);
    expect(store.listSessions({ limit: 2 }).map((r) => r.sessionKey)).toEqual(["S5", "S4"]);
    expect(store.listSessions({ limit: 2, offset: 2 }).map((r) => r.sessionKey)).toEqual(["S3", "S2"]);
    store.close();
  });

  test("collapses legacy synthetic dupes that differ only sub-second; keeps most-complete", () => {
    const store = new Store(":memory:");
    // Simulate pre-fix dupes: two synthetic-keyed rows for ONE logical daemon
    // session — same host/pid/provider, started_at within the same second
    // (1700000000123 vs 1700000000777 -> both floor to second 1700000000).
    const ins = store.db.query(
      `INSERT INTO sessions (session_key, live_id, provider, host_id, host_label, cwd, category,
         started_at, ended_at, state, last_seen_at)
       VALUES ($k, $live, 'hermes', 'h', 'H', '/r', 'code', $start, $end, $state, $seen)`,
    );
    // older/less-complete row (closed earlier, older last_seen)
    ins.run({ $k: "h:9:1700000000123", $live: "h:9", $start: 1_700_000_000_123, $end: 5000, $state: "closed", $seen: 5000 });
    // newer/more-complete row (longer-lived: bigger ended_at + last_seen)
    ins.run({ $k: "h:9:1700000000777", $live: "h:9", $start: 1_700_000_000_777, $end: 9000, $state: "closed", $seen: 9000 });

    const rows = store.listSessions();
    expect(rows.length).toBe(1);
    expect(rows[0]!.sessionKey).toBe("h:9:1700000000777"); // newer last_seen_at wins
    expect(store.countSessions()).toBe(1);
    store.close();
  });

  test("does NOT collapse distinct provider-native rows that share host/pid/second", () => {
    const store = new Store(":memory:");
    // Two genuinely-distinct claude sessions (provider-native ids) that, after a
    // pid reuse/restart, happen to share host+pid+second. They must NOT be merged.
    const ins = store.db.query(
      `INSERT INTO sessions (session_key, live_id, provider, host_id, host_label, cwd, category,
         started_at, ended_at, state, last_seen_at)
       VALUES ($k, $live, 'claude', 'h', 'H', '/r', 'code', $start, $end, 'closed', $seen)`,
    );
    ins.run({ $k: "UUID-A", $live: "h:7", $start: 1_700_000_000_100, $end: 5000, $seen: 5000 });
    ins.run({ $k: "UUID-B", $live: "h:7", $start: 1_700_000_000_900, $end: 9000, $seen: 9000 });
    const rows = store.listSessions();
    expect(rows.map((r) => r.sessionKey).sort()).toEqual(["UUID-A", "UUID-B"]);
    expect(store.countSessions()).toBe(2);
    store.close();
  });
});

describe("Store.getSession", () => {
  const base = { id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H",
    cwd: "/r", category: "code", startedAt: 1, cpu: 0, memMb: 0, providerSessionId: "P9" };

  test("returns session + its events newest-first", () => {
    const store = new Store(":memory:");
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1, sessions: [{ ...base, toolsUsed: ["bash"] }] } as any, 1);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 2, sessions: [{ ...base, toolsUsed: ["bash", "edit"] }] } as any, 2);
    const res = store.getSession("P9");
    expect(res).not.toBeNull();
    expect(res!.session.sessionKey).toBe("P9");
    expect(res!.session.provider).toBe("claude");
    // events newest-first: tool event (at=2) before started (at=1)
    expect(res!.events[0].type).toBe("session.tool");
    expect(res!.events[0].detail).toEqual({ tool: "edit" });
    expect(res!.events.at(-1)!.type).toBe("session.started");
    store.close();
  });

  test("returns null for unknown key", () => {
    const store = new Store(":memory:");
    expect(store.getSession("nope")).toBeNull();
    store.close();
  });
});

describe("Store.getSamples", () => {
  function seedSample(store: Store, key: string, at: number, resolution: string, vals: any = {}) {
    store.db.query(
      `INSERT INTO samples (session_key, at, resolution, cost_usd, context_tokens, context_window, cpu, mem_mb, active)
       VALUES ($k,$at,$res,$cost,$ctx,$cw,$cpu,$mem,$active)`,
    ).run({ $k: key, $at: at, $res: resolution, $cost: vals.cost_usd ?? null,
      $ctx: vals.context_tokens ?? null, $cw: vals.context_window ?? null,
      $cpu: vals.cpu ?? null, $mem: vals.mem_mb ?? null, $active: vals.active ?? 0 });
  }

  test("returns ASC by at and maps to camelCase", () => {
    const store = new Store(":memory:");
    seedSample(store, "S1", 300, "raw", { cost_usd: 0.3, context_tokens: 30, active: 1 });
    seedSample(store, "S1", 100, "raw", { cost_usd: 0.1, context_tokens: 10, active: 0 });
    seedSample(store, "S1", 200, "raw", { cost_usd: 0.2 });
    const rows = store.getSamples("S1", { resolution: "raw" });
    expect(rows.map((r) => r.at)).toEqual([100, 200, 300]);
    expect(rows[0].costUsd).toBe(0.1);
    expect(rows[0].contextTokens).toBe(10);
    expect(rows[0].active).toBe(0);
    expect(rows[0].resolution).toBe("raw");
    store.close();
  });

  test("auto resolution picks raw for short span", () => {
    const store = new Store(":memory:", { retention: { rawDays: 15, hourDays: 90 } });
    const since = 1_000_000;
    const until = since + 5 * DAY; // <= rawDays
    seedSample(store, "S1", since + 1, "raw", { cost_usd: 0.1 });
    seedSample(store, "S1", since + 1, "hour", { cost_usd: 0.9 });
    const rows = store.getSamples("S1", { since, until });
    expect(rows.length).toBe(1);
    expect(rows[0].resolution).toBe("raw");
    store.close();
  });

  test("auto resolution picks hour for mid span", () => {
    const store = new Store(":memory:", { retention: { rawDays: 15, hourDays: 90 } });
    const since = 1_000_000;
    const until = since + 30 * DAY; // > rawDays, <= hourDays
    seedSample(store, "S1", since + 1, "raw", { cost_usd: 0.1 });
    seedSample(store, "S1", since + 1, "hour", { cost_usd: 0.9 });
    const rows = store.getSamples("S1", { since, until });
    expect(rows.length).toBe(1);
    expect(rows[0].resolution).toBe("hour");
    store.close();
  });

  test("auto resolution picks day for long span", () => {
    const store = new Store(":memory:", { retention: { rawDays: 15, hourDays: 90 } });
    const since = 1_000_000;
    const until = since + 200 * DAY; // > hourDays
    seedSample(store, "S1", since + 1, "hour", { cost_usd: 0.1 });
    seedSample(store, "S1", since + 1, "day", { cost_usd: 0.9 });
    const rows = store.getSamples("S1", { since, until });
    expect(rows.length).toBe(1);
    expect(rows[0].resolution).toBe("day");
    store.close();
  });

  test("auto defaults to raw when no since/until given", () => {
    const store = new Store(":memory:");
    seedSample(store, "S1", 100, "raw", { cost_usd: 0.1 });
    seedSample(store, "S1", 100, "hour", { cost_usd: 0.9 });
    const rows = store.getSamples("S1");
    expect(rows.length).toBe(1);
    expect(rows[0].resolution).toBe("raw");
    store.close();
  });

  test("filters by since/until on at", () => {
    const store = new Store(":memory:");
    seedSample(store, "S1", 100, "raw");
    seedSample(store, "S1", 200, "raw");
    seedSample(store, "S1", 300, "raw");
    const rows = store.getSamples("S1", { resolution: "raw", since: 150, until: 250 });
    expect(rows.map((r) => r.at)).toEqual([200]);
    store.close();
  });
});

describe("Store.listEvents", () => {
  const base = { id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H",
    cwd: "/r", category: "code", startedAt: 1, cpu: 0, memMb: 0, providerSessionId: "P9" };

  test("newest-first, filters by type and sessionKey, parses detail", () => {
    const store = new Store(":memory:");
    store.record({ hostId: "h", hostLabel: "H", sentAt: 1, sessions: [{ ...base, toolsUsed: ["bash"] }] } as any, 1);
    store.record({ hostId: "h", hostLabel: "H", sentAt: 2, sessions: [{ ...base, toolsUsed: ["bash", "edit"] }] } as any, 2);
    const all = store.listEvents();
    expect(all[0].at).toBeGreaterThanOrEqual(all[all.length - 1].at);
    const tools = store.listEvents({ type: "session.tool" });
    expect(tools.length).toBe(1);
    expect(tools[0].detail).toEqual({ tool: "edit" });
    expect(tools[0].sessionKey).toBe("P9");
    const byKey = store.listEvents({ sessionKey: "P9" });
    expect(byKey.length).toBeGreaterThan(0);
    expect(store.listEvents({ sessionKey: "other" }).length).toBe(0);
    store.close();
  });

  test("filters by since/until and respects limit", () => {
    const store = new Store(":memory:");
    for (let i = 1; i <= 5; i++) {
      store.db.query("INSERT INTO events (at, session_key, type) VALUES (?,?,?)").run(i * 100, "S1", "session.started");
    }
    expect(store.listEvents({ since: 200, until: 400 }).map((e) => e.at)).toEqual([400, 300, 200]);
    expect(store.listEvents({ limit: 2 }).map((e) => e.at)).toEqual([500, 400]);
    store.close();
  });
});

describe("Store.maybeCompact", () => {
  test("first call runs; second within interval is skipped", () => {
    const NOW = Date.UTC(2026, 0, 100);
    const store = new Store(":memory:", { retention: { rawDays: 15, compactIntervalMs: HOUR } });
    store.db.query(
      `INSERT INTO samples (session_key, at, resolution, cost_usd, context_window, active)
       VALUES (?,?, 'raw', ?, ?, ?)`,
    ).run("S1", NOW - 20 * DAY, 0.1, 1000, 1);
    store.maybeCompact(NOW); // runs -> promotes to hour
    let hours = store.db.query("SELECT COUNT(*) c FROM samples WHERE resolution='hour'").get() as any;
    expect(hours.c).toBe(1);
    // add another old raw; a call within compactIntervalMs should NOT run
    store.db.query(
      `INSERT INTO samples (session_key, at, resolution, cost_usd, context_window, active)
       VALUES (?,?, 'raw', ?, ?, ?)`,
    ).run("S2", NOW - 20 * DAY, 0.1, 1000, 1);
    store.maybeCompact(NOW + 60_000); // within interval -> skip
    const raw = store.db.query("SELECT COUNT(*) c FROM samples WHERE resolution='raw'").get() as any;
    expect(raw.c).toBe(1); // S2 still raw
    // past the interval -> runs
    store.maybeCompact(NOW + HOUR + 1);
    const raw2 = store.db.query("SELECT COUNT(*) c FROM samples WHERE resolution='raw'").get() as any;
    expect(raw2.c).toBe(0);
    store.close();
  });
});

describe("Store.importSession", () => {
  const mk = (key: string, over: any = {}) => ({
    sessionKey: key, liveId: key, provider: "claude", hostId: "h", hostLabel: "H",
    cwd: "/r", category: "code", startedAt: 1000, state: "closed", lastSeenAt: 2000, ...over,
  } as any);
  test("imports a new session and returns 'imported'", () => {
    const s = new Store(":memory:");
    const r = s.importSession(mk("K1", { subject: "hi", summary: "did x", attention: true, ask: "ok?" }), [], []);
    expect(r).toBe("imported");
    const row: any = s.db.query("SELECT * FROM sessions WHERE session_key='K1'").get();
    expect(row.state).toBe("closed");
    expect(row.summary).toBe("did x");
    expect(row.attention).toBe(1);
    expect(row.ask).toBe("ok?");
    s.close();
  });
  test("skips when session_key already exists (live wins)", () => {
    const s = new Store(":memory:");
    s.importSession(mk("K1", { subject: "first" }), [], []);
    const r = s.importSession(mk("K1", { subject: "second" }), [], []);
    expect(r).toBe("skipped");
    const row: any = s.db.query("SELECT subject FROM sessions WHERE session_key='K1'").get();
    expect(row.subject).toBe("first");
    s.close();
  });
  test("imports samples and events under the same call", () => {
    const s = new Store(":memory:");
    s.importSession(mk("K1"),
      [{ sessionKey: "K1", at: 3_600_000, resolution: "hour", tokensOut: 10, costUsd: 0.1 }] as any,
      [{ at: 1000, sessionKey: "K1", type: "session.started" }] as any);
    expect((s.db.query("SELECT COUNT(*) c FROM samples WHERE session_key='K1'").get() as any).c).toBe(1);
    expect((s.db.query("SELECT COUNT(*) c FROM events WHERE session_key='K1'").get() as any).c).toBe(1);
    s.close();
  });
  test("has() reflects presence", () => {
    const s = new Store(":memory:");
    expect(s.has("K1")).toBe(false);
    s.importSession(mk("K1"), [], []);
    expect(s.has("K1")).toBe(true);
    s.close();
  });
  test("enrichment columns round-trip on read (attention as strict boolean)", () => {
    const s = new Store(":memory:");
    s.importSession(mk("K1", { summary: "x", attention: true, ask: "q" }), [], []);
    const session = s.getSession("K1")!.session;
    expect(session.summary).toBe("x");
    expect(session.attention).toBe(true);
    expect(session.ask).toBe("q");
    s.close();
  });
});

describe("Store.applyEnrichment", () => {
  const mk = (key: string, over: any = {}) => ({
    sessionKey: key, liveId: key, provider: "claude", hostId: "h", hostLabel: "H",
    cwd: "/r", category: "code", startedAt: 1000, state: "closed", lastSeenAt: 2000, ...over,
  } as any);
  test("sets summary/attention/ask/suggestion and keeps existing subject when model subject omitted", () => {
    const s = new Store(":memory:");
    s.importSession(mk("K1", { subject: "heuristic subj" }), [], []); // summary NULL
    expect(s.getSession("K1")!.session.summary).toBeUndefined();
    s.applyEnrichment("K1", { summary: "doing the thing", attention: true, ask: "ok?", suggestion: "yes, proceed" });
    const session = s.getSession("K1")!.session;
    expect(session.summary).toBe("doing the thing");
    expect(session.attention).toBe(true);
    expect(session.ask).toBe("ok?");
    expect(session.suggestion).toBe("yes, proceed");
    expect(session.subject).toBe("heuristic subj"); // COALESCE kept it
    // attention stored as 1
    const row: any = s.db.query("SELECT attention FROM sessions WHERE session_key='K1'").get();
    expect(row.attention).toBe(1);
    s.close();
  });
  test("replaces subject when a model subject is provided", () => {
    const s = new Store(":memory:");
    s.importSession(mk("K1", { subject: "old" }), [], []);
    s.applyEnrichment("K1", { subject: "new subject", summary: "x" });
    expect(s.getSession("K1")!.session.subject).toBe("new subject");
    s.close();
  });
  test("attention false stores as 0; omitted ask/suggestion null out", () => {
    const s = new Store(":memory:");
    s.importSession(mk("K1", { ask: "prev", suggestion: "prev" }), [], []);
    s.applyEnrichment("K1", { summary: "s", attention: false });
    const row: any = s.db.query("SELECT attention, ask, suggestion FROM sessions WHERE session_key='K1'").get();
    expect(row.attention).toBe(0);
    expect(row.ask).toBeNull();
    expect(row.suggestion).toBeNull();
    s.close();
  });
});

describe("Store.sessionsMissingEnrichment", () => {
  const mk = (key: string, over: any = {}) => ({
    sessionKey: key, liveId: key, provider: "claude", hostId: "h", hostLabel: "H",
    cwd: "/r", category: "code", startedAt: 1000, state: "closed", lastSeenAt: 2000, ...over,
  } as any);
  test("returns ONLY closed rows with summary NULL; never live (running) rows", () => {
    const s = new Store(":memory:");
    // A closed (backfilled) row with no summary — eligible.
    s.importSession(mk("CLOSED", { subject: "subC" }), [], []);
    // A running (live) row with no summary — must be excluded so a concurrent
    // enrich pass can never clobber what the live reporter wrote.
    s.importSession(mk("RUNNING", { state: "running" }), [], []);
    const keys = s.sessionsMissingEnrichment().map((r) => r.sessionKey);
    expect(keys).toEqual(["CLOSED"]);
    s.close();
  });
  test("excludes orphaned rows too (only state='closed' is enriched)", () => {
    const s = new Store(":memory:");
    s.importSession(mk("CLOSED"), [], []);
    s.importSession(mk("ORPH", { state: "orphaned" }), [], []);
    const keys = s.sessionsMissingEnrichment().map((r) => r.sessionKey);
    expect(keys).toEqual(["CLOSED"]);
    s.close();
  });
});

test("live record() persists summary/attention/ask onto the registry", () => {
  const s = new Store(":memory:");
  s.record({ hostId: "h", hostLabel: "H", sentAt: 1, sessions: [
    { id: "h:5", provider: "claude", pid: 5, hostId: "h", hostLabel: "H", cwd: "/r",
      category: "code", startedAt: 1, cpu: 0, memMb: 0, providerSessionId: "P9",
      summary: "working", attention: true, ask: "approve?" }] } as any, 1);
  const row: any = s.db.query("SELECT summary, attention, ask FROM sessions WHERE session_key='P9'").get();
  expect(row.summary).toBe("working");
  expect(row.attention).toBe(1);
  expect(row.ask).toBe("approve?");
  s.close();
});

describe("Store.setRetention", () => {
  test("merges a partial over the current config", () => {
    const store = new Store(":memory:", { sampleIntervalMs: 60_000 } as any);
    expect(store.retentionConfig.rawDays).toBe(15);
    store.setRetention({ rawDays: 1 });
    expect(store.retentionConfig.rawDays).toBe(1);
    // unspecified fields are preserved
    expect(store.retentionConfig.sampleIntervalMs).toBe(60_000);
    expect(store.retentionConfig.hourDays).toBe(90);
    store.close();
  });

  test("new sampleIntervalMs gate takes effect on subsequent records", () => {
    const store = new Store(":memory:", { sampleIntervalMs: 60_000 } as any);
    const s = () => ({ id: "h:5", provider: "claude", pid: 5, hostId: "h",
      hostLabel: "H", cwd: "/r", category: "code", startedAt: 1, cpu: 1, memMb: 2,
      providerSessionId: "P9", costUsd: 0.1, active: true });
    store.record({ hostId: "h", hostLabel: "H", sentAt: 0, sessions: [s()] } as any, 0);
    // would normally be throttled at 30s under the 60s gate
    store.setRetention({ sampleIntervalMs: 10_000 });
    store.record({ hostId: "h", hostLabel: "H", sentAt: 30_000, sessions: [s()] } as any, 30_000);
    const n = store.db.query("SELECT COUNT(*) c FROM samples WHERE resolution='raw'").get() as any;
    expect(n.c).toBe(2);
    store.close();
  });
});

describe("Store.listSessions/countSessions minTokens + pagination", () => {
  const mk = (key: string, over: any = {}) => ({
    sessionKey: key, liveId: key, provider: "claude", hostId: "h", hostLabel: "H",
    cwd: "/r", category: "code", startedAt: 1000, state: "closed", lastSeenAt: 2000, ...over,
  });

  test("minTokens hides low-token closed rows but keeps running ones", () => {
    const s = new Store(":memory:");
    s.importSession(mk("RICH", { startedAt: 3, tokensIn: 5000 }), [], []);          // closed, 5000
    s.importSession(mk("PHANTOM", { startedAt: 2, tokensIn: 0 }), [], []);           // closed, 0
    s.importSession(mk("LIVE", { startedAt: 1, state: "running", tokensIn: 0 }), [], []); // running, 0
    const keys = s.listSessions({ minTokens: 1000 }).map((r) => r.sessionKey);
    expect(keys).toContain("RICH");
    expect(keys).toContain("LIVE");      // running is exempt
    expect(keys).not.toContain("PHANTOM");
    expect(s.countSessions({ minTokens: 1000 })).toBe(2);
    s.close();
  });

  test("countSessions ignores limit/offset; pagination splits the set", () => {
    const s = new Store(":memory:");
    for (let i = 0; i < 5; i++) s.importSession(mk(`K${i}`, { startedAt: i, tokensIn: 9999 }), [], []);
    expect(s.countSessions({})).toBe(5);
    const p0 = s.listSessions({ limit: 2, offset: 0 });
    const p1 = s.listSessions({ limit: 2, offset: 2 });
    expect(p0.length).toBe(2);
    expect(p1.length).toBe(2);
    expect(p0[0].sessionKey).not.toBe(p1[0].sessionKey);
    s.close();
  });
});

describe("Store work items / quests + search", () => {
  function rep(sessions: any[], sentAt = 1000): any {
    return { hostId: "h1", hostLabel: "H1", sentAt, sessions };
  }
  function sess(over: any = {}): any {
    return { id: "h1:1", provider: "claude", pid: 1, hostId: "h1", hostLabel: "H1",
      cwd: "/x", category: "code", startedAt: 500, cpu: 0, memMb: 0,
      providerSessionId: "SID", ...over };
  }

  test("record: persists workItems and upsert keeps final status when item drops out", () => {
    const s = new Store(":memory:");
    s.record(rep([sess({ workItems: [
      { itemKey: "a", subject: "alpha", status: "in_progress", position: 0 },
      { itemKey: "b", subject: "beta", status: "pending", position: 1 },
    ] })], 1000), 1000);

    let q = s.getQuests("SID");
    expect(q.map((x) => x.itemKey).sort()).toEqual(["a", "b"]);
    expect(q.find((x) => x.itemKey === "a")!.status).toBe("in_progress");

    s.record(rep([sess({ workItems: [
      { itemKey: "a", subject: "alpha", status: "completed", position: 0 },
    ] })], 2000), 2000);

    q = s.getQuests("SID");
    expect(q.find((x) => x.itemKey === "a")!.status).toBe("completed");
    expect(q.find((x) => x.itemKey === "b")!.status).toBe("pending");
    s.close();
  });

  test("listQuests: cross-session board filters by status/provider, joins session context", () => {
    const s = new Store(":memory:");
    s.record(rep([sess({ workItems: [
      { itemKey: "a", subject: "alpha", status: "in_progress", position: 0 },
    ] })], 1000), 1000);
    s.record(rep([sess({ id: "h1:2", pid: 2, providerSessionId: "SID2", provider: "codex",
      workItems: [{ itemKey: "c", subject: "gamma", status: "completed", position: 0 }] })], 1000), 1000);

    const all = s.listQuests({});
    expect(all.length).toBe(2);
    expect(all[0]).toHaveProperty("sessionKey");
    expect(all[0]).toHaveProperty("provider");

    const inProg = s.listQuests({ status: "in_progress" });
    expect(inProg.map((q) => q.itemKey)).toEqual(["a"]);

    const codex = s.listQuests({ provider: "codex" });
    expect(codex.map((q) => q.itemKey)).toEqual(["c"]);
    s.close();
  });

  test("listSessions: q ANDs terms across fields; sort/order with NULLS LAST", () => {
    const s = new Store(":memory:");
    s.record(rep([
      sess({ id: "h1:1", pid: 1, providerSessionId: "k1", subject: "refactor auth", costUsd: 5 }),
      sess({ id: "h1:2", pid: 2, providerSessionId: "k2", subject: "auth tests", displayName: "scout", costUsd: 1 }),
      sess({ id: "h1:3", pid: 3, providerSessionId: "k3", subject: "unrelated", costUsd: undefined }),
    ], 1000), 1000);

    expect(s.listSessions({ q: "auth" }).map((x) => x.sessionKey).sort()).toEqual(["k1", "k2"]);
    expect(s.listSessions({ q: "auth scout" }).map((x) => x.sessionKey)).toEqual(["k2"]);
    const byCost = s.listSessions({ sort: "cost", order: "desc" }).map((x) => x.sessionKey);
    expect(byCost.slice(0, 2)).toEqual(["k1", "k2"]);
    expect(byCost[2]).toBe("k3");
    expect(s.countSessions({ q: "auth" })).toBe(2);
    s.close();
  });

  test("listSessions/facets: host filters by host_id and self-excludes", () => {
    const s = new Store(":memory:");
    s.record(rep([sess({ id: "h1:1", pid: 1, providerSessionId: "k1" })], 1000), 1000);
    s.record({ hostId: "h2", hostLabel: "H2", sentAt: 1000, sessions: [
      sess({ id: "h2:1", pid: 1, providerSessionId: "k2", hostId: "h2", hostLabel: "H2" }),
    ] } as any, 1000);
    expect(s.listSessions({ host: "h1" }).map((x) => x.sessionKey)).toEqual(["k1"]);
    expect(s.countSessions({ host: "h2" })).toBe(1);
    // self-excluding: hosts facet still lists both even with host filter applied
    const f = s.facets({ host: "h1" });
    expect(f.hosts.map((h) => h.value).sort()).toEqual(["h1", "h2"]);
    s.close();
  });

  test("facets: self-excluding — provider facet ignores active provider filter", () => {
    const s = new Store(":memory:");
    s.record(rep([
      sess({ id: "h1:1", pid: 1, providerSessionId: "k1", provider: "claude", category: "code" }),
      sess({ id: "h1:2", pid: 2, providerSessionId: "k2", provider: "codex", category: "review" }),
    ], 1000), 1000);

    const f0 = s.facets({});
    expect(f0.providers.find((p) => p.value === "claude")!.count).toBe(1);
    expect(f0.providers.find((p) => p.value === "codex")!.count).toBe(1);

    const f1 = s.facets({ provider: "claude" });
    expect(f1.providers.map((p) => p.value).sort()).toEqual(["claude", "codex"]);
    expect(f1.categories.map((c) => c.value)).toEqual(["code"]);
    s.close();
  });

  test("timeseries: per-session delta, clamps restarts, buckets by day", () => {
    const s = new Store(":memory:", { sampleIntervalMs: 0 });
    const D = 86_400_000;
    const base = sess({ providerSessionId: "k1" });
    s.record(rep([{ ...base, costUsd: 0, contextTokens: 0 }], 0), 0);
    s.record(rep([{ ...base, costUsd: 2, contextTokens: 0 }], D), D);
    s.record(rep([{ ...base, costUsd: 5, contextTokens: 0 }], 2 * D), 2 * D);
    s.record(rep([{ ...base, costUsd: 1, contextTokens: 0 }], 3 * D), 3 * D);

    const ts = s.timeseries({ since: 0, until: 4 * D, bucket: "day", metric: "cost" });
    const byT = Object.fromEntries(ts.series[0].points.map((p) => [p.t, p.value]));
    expect(byT[0]).toBe(0);
    expect(byT[D]).toBe(2);
    expect(byT[2 * D]).toBe(3);
    expect(byT[3 * D]).toBe(0);
    s.close();
  });

  test("timeseries: reads across resolutions (raw recent + day-resolution old)", () => {
    const s = new Store(":memory:", { sampleIntervalMs: 0 });
    const D = 86_400_000;
    // Old window: a separate session imported with day-resolution cumulative samples.
    s.importSession(
      { sessionKey: "old", liveId: "h1:9", provider: "claude", hostId: "h1", hostLabel: "H1",
        cwd: "/x", category: "code", startedAt: 0, state: "closed", lastSeenAt: 2 * D, endedAt: 2 * D },
      [
        { sessionKey: "old", at: 0, resolution: "day", costUsd: 0 },
        { sessionKey: "old", at: D, resolution: "day", costUsd: 4 },
      ],
      [],
    );
    // Recent window: raw samples on a live session.
    const base = sess({ providerSessionId: "k1", startedAt: 10 * D });
    s.record(rep([{ ...base, costUsd: 0 }], 10 * D), 10 * D);
    s.record(rep([{ ...base, costUsd: 3 }], 11 * D), 11 * D);

    const ts = s.timeseries({ since: 0, until: 12 * D, bucket: "day", metric: "cost" });
    const byT = Object.fromEntries(ts.series[0].points.map((p) => [p.t, p.value]));
    expect(byT[D]).toBe(4);       // from day-resolution old session
    expect(byT[11 * D]).toBe(3);  // from raw recent session
    s.close();
  });
});

describe("Store templates / lords", () => {
  test("templates: create, list, get, archive", () => {
    const s = new Store(":memory:");
    s.createTemplate({ id: "code-review", name: "Code Review Lord", provider: "codex", args: ["--model", "o1"], createdAt: 1000 });
    const all = s.listTemplates();
    expect(all.length).toBe(1);
    expect(all[0]!.id).toBe("code-review");
    expect(all[0]!.troopsDeployed).toBe(0);
    expect(all[0]!.level).toBe(1);
    s.archiveTemplate("code-review", 2000);
    expect(s.listTemplates().length).toBe(0);            // archived excluded by default
    expect(s.getTemplate("code-review")?.archivedAt).toBe(2000); // still fetchable by id
    s.close();
  });

  test("templates: XP rolls up from sessions tagged with template_id", () => {
    const s = new Store(":memory:");
    s.createTemplate({ id: "feat", name: "Feature Lord", provider: "claude", args: [], createdAt: 1000 });
    const report = {
      hostId: "h1", hostLabel: "host", sentAt: 5000,
      sessions: [
        { id: "h1:11", provider: "claude", pid: 11, hostId: "h1", hostLabel: "host", cwd: "/a", category: "code", startedAt: 4000, cpu: 0, memMb: 0, tokensIn: 20000, tokensOut: 0, costUsd: 1, templateId: "feat" },
        { id: "h1:12", provider: "claude", pid: 12, hostId: "h1", hostLabel: "host", cwd: "/b", category: "code", startedAt: 4000, cpu: 0, memMb: 0, tokensIn: 0, tokensOut: 0, costUsd: 2, templateId: "feat" },
      ],
    } as any;
    s.record(report, 5000);
    const lord = s.getTemplate("feat")!;
    expect(lord.troopsDeployed).toBe(2);
    expect(lord.totalCost).toBe(3);
    expect(lord.totalTokens).toBe(20000);
    expect(lord.level).toBeGreaterThanOrEqual(1);
    s.close();
  });

  test("templates: lineage is sticky — a later tick omitting templateId does not detach", () => {
    const s = new Store(":memory:");
    s.createTemplate({ id: "feat", name: "Feature Lord", provider: "claude", args: [], createdAt: 1000 });
    const base = { id: "h1:11", provider: "claude", pid: 11, hostId: "h1", hostLabel: "host",
      cwd: "/a", category: "code", startedAt: 4000, cpu: 0, memMb: 0, providerSessionId: "P1" };
    s.record({ hostId: "h1", hostLabel: "host", sentAt: 5000,
      sessions: [{ ...base, templateId: "feat" }] } as any, 5000);
    expect(s.getTemplate("feat")!.troopsDeployed).toBe(1);
    // Reporter env-read transiently returns null this tick (templateId omitted).
    s.record({ hostId: "h1", hostLabel: "host", sentAt: 6000,
      sessions: [{ ...base }] } as any, 6000);
    expect(s.getTemplate("feat")!.troopsDeployed).toBe(1); // still attached
    const row: any = s.db.query("SELECT template_id FROM sessions WHERE session_key='P1'").get();
    expect(row.template_id).toBe("feat");
    s.close();
  });

  test("templates: updateTemplate revives an archived template", () => {
    const s = new Store(":memory:");
    s.createTemplate({ id: "feat", name: "Feature Lord", provider: "claude", args: [], createdAt: 1000 });
    s.archiveTemplate("feat", 2000);
    expect(s.listTemplates().length).toBe(0);
    expect(s.updateTemplate("feat", { name: "Renamed Lord" })).toBe(true);
    expect(s.getTemplate("feat")?.archivedAt).toBeUndefined();
    const revived = s.listTemplates();
    expect(revived.length).toBe(1);
    expect(revived[0]!.name).toBe("Renamed Lord");
    s.close();
  });

  test("templates: backend defaults to iterm2 and roundtrips tmux", () => {
    const s = new Store(":memory:");
    s.createTemplate({ id: "a", name: "A", provider: "claude", args: [], createdAt: 1 });
    expect(s.getTemplate("a")?.backend).toBe("iterm2"); // default
    s.createTemplate({ id: "b", name: "B", provider: "codex", args: [], backend: "tmux", createdAt: 1 });
    expect(s.getTemplate("b")?.backend).toBe("tmux");
    expect(s.updateTemplate("b", { backend: "iterm2" })).toBe(true);
    expect(s.getTemplate("b")?.backend).toBe("iterm2");
    s.close();
  });

  test("migrates a pre-existing DB whose sessions table lacks template_id", () => {
    // Reproduces the runtime crash on an old on-disk mc.db: the sessions table
    // exists without template_id, so indexing/using that column during migrate
    // must not throw — the guarded ALTER adds it, then the index is built.
    const file = join(tmpdir(), `mc-legacy-${Date.now()}-${Math.floor(performance.now())}.db`);
    try {
      const legacy = new Database(file);
      // the real sessions schema as it stood right BEFORE this feature — every
      // historical column present EXCEPT template_id (which the guarded ALTER adds).
      legacy.exec(`CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY, live_id TEXT, resume_id TEXT,
        provider TEXT, host_id TEXT, host_label TEXT, cwd TEXT,
        category TEXT, model TEXT, handle TEXT, display_name TEXT, subject TEXT,
        started_at INTEGER, ended_at INTEGER, state TEXT, last_seen_at INTEGER,
        cost_usd REAL, tokens_in INTEGER, tokens_out INTEGER,
        tokens_cache_read INTEGER, tokens_cache_write INTEGER,
        peak_context_tokens INTEGER, tools_used TEXT,
        summary TEXT, attention INTEGER, ask TEXT, suggestion TEXT
      );`);
      legacy.run(
        "INSERT INTO sessions (session_key, provider, state, cost_usd, tokens_in, tokens_out) VALUES ('old:1','claude','closed',2,1000,500)",
      );
      legacy.close();

      // Opening a Store on the legacy file must migrate without throwing.
      const s = new Store(file);
      // template_id column now exists and the index is present.
      const cols = (s.db.query("PRAGMA table_info(sessions)").all() as any[]).map((c) => c.name);
      expect(cols).toContain("template_id");
      const idx = s.db
        .query("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_sessions_template'")
        .get();
      expect(idx).toBeTruthy();
      // a lord rolls up cleanly against the migrated table (the legacy row is untagged).
      s.createTemplate({ id: "feat", name: "Feature Lord", provider: "claude", args: [], createdAt: 1 });
      expect(s.getTemplate("feat")?.troopsDeployed).toBe(0);
      s.close();
    } finally {
      try { unlinkSync(file); } catch { /* ignore */ }
    }
  });
});

describe("Store managed quests", () => {
  function sess(over: any = {}): any {
    return { id: "h1:1", provider: "claude", pid: 1, hostId: "h1", hostLabel: "H1",
      cwd: "/x", category: "code", startedAt: 500, cpu: 0, memMb: 0, providerSessionId: "SID", ...over };
  }

  test("create/list/update/delete managed quest assigned to a lord (no session yet)", () => {
    const s = new Store(":memory:");
    s.createTemplate({ id: "lord1", name: "Scout", provider: "claude", args: [], createdAt: 1 });
    const q = s.createQuest({ subject: "scout the repo", templateId: "lord1", now: 1000 });
    expect(q.id).toBeTruthy();
    expect(q.status).toBe("pending");
    expect(q.templateId).toBe("lord1");
    expect(q.sessionKey).toBeUndefined();

    // listed + enriched with lord name (no session needed)
    const list = s.listManagedQuests({ templateId: "lord1" });
    expect(list.length).toBe(1);
    expect(list[0].templateName).toBe("Scout");
    expect(list[0].provider).toBe("claude");

    // status filter
    expect(s.listManagedQuests({ status: "in_progress" }).length).toBe(0);
    expect(s.updateQuest(q.id, { status: "in_progress" }, 2000)).toBe(true);
    expect(s.listManagedQuests({ status: "in_progress" }).length).toBe(1);

    expect(s.deleteQuest(q.id)).toBe(true);
    expect(s.listManagedQuests({}).length).toBe(0);
    s.close();
  });

  test("quest assigned to a running session enriches with session context", () => {
    const s = new Store(":memory:");
    s.record({ hostId: "h1", hostLabel: "H1", sentAt: 1000, sessions: [sess({ displayName: "scout" })] } as any, 1000);
    const q = s.createQuest({ subject: "fix bug", sessionKey: "SID", now: 1000 });
    const list = s.listManagedQuests({ sessionKey: "SID" });
    expect(list.length).toBe(1);
    expect(list[0].sessionDisplayName).toBe("scout");
    expect(list[0].provider).toBe("claude");
    expect(list[0].sessionState).toBe("running");
    expect(s.getQuest(q.id)?.subject).toBe("fix bug");
    s.close();
  });

  test("questsForTemplate returns a lord's quests for deploy folding", () => {
    const s = new Store(":memory:");
    s.createTemplate({ id: "lord1", name: "Scout", provider: "claude", args: [], createdAt: 1 });
    const a = s.createQuest({ subject: "task A", templateId: "lord1", now: 1 });
    s.createQuest({ subject: "task B", templateId: "lord1", now: 2 });
    const got = s.questsForTemplate("lord1");
    expect(got.map((q) => q.subject).sort()).toEqual(["task A", "task B"]);
    expect(s.getQuest(a.id)?.subject).toBe("task A");
    s.close();
  });
});

describe("Store sub-sessions", () => {
  function rep(sessions: any[], sentAt = 1000): any {
    return { hostId: "h1", hostLabel: "H1", sentAt, sessions };
  }
  function sess(over: any = {}): any {
    return { id: "h1:1", provider: "claude", pid: 1, hostId: "h1", hostLabel: "H1",
      cwd: "/x", category: "code", startedAt: 500, cpu: 0, memMb: 0,
      providerSessionId: "SID", ...over };
  }

  test("record upserts subSessions and getSubagents reads them back", () => {
    const s = new Store(":memory:");
    s.record(rep([sess({ subSessions: [
      { agentId: "a1", kind: "Explore", tokensIn: 100, tokensOut: 20,
        tokensCacheRead: 5, tokensCacheWrite: 3, costUsd: 0.5, model: "opus",
        peakContextTokens: 3000, toolsUsed: ["Grep", "Read"], firstAt: 600, lastAt: 700 },
      { agentId: "a2", kind: "code-review", tokensOut: 40 },
    ] })], 1000), 1000);

    const subs = s.getSubagents("SID");
    expect(subs.map((x) => x.agentId).sort()).toEqual(["a1", "a2"]);
    const a1 = subs.find((x) => x.agentId === "a1")!;
    expect(a1.sessionKey).toBe("SID");
    expect(a1.kind).toBe("Explore");
    expect(a1.tokensIn).toBe(100);
    expect(a1.costUsd).toBe(0.5);
    expect(a1.model).toBe("opus");
    expect(a1.peakContextTokens).toBe(3000);
    expect(a1.toolsUsed).toEqual(["Grep", "Read"]);
    expect(a1.firstAt).toBe(600);
    expect(a1.lastAt).toBe(700);
    s.close();
  });

  test("record upsert overwrites a subagent's later totals", () => {
    const s = new Store(":memory:");
    s.record(rep([sess({ subSessions: [{ agentId: "a1", tokensOut: 10 }] })], 1000), 1000);
    s.record(rep([sess({ subSessions: [{ agentId: "a1", tokensOut: 99, costUsd: 1.2 }] })], 2000), 2000);
    const subs = s.getSubagents("SID");
    expect(subs.length).toBe(1);
    expect(subs[0].tokensOut).toBe(99);
    expect(subs[0].costUsd).toBe(1.2);
    s.close();
  });

  test("subagents are NOT inserted into the sessions registry (no double-count)", () => {
    const s = new Store(":memory:");
    s.record(rep([sess({ subSessions: [{ agentId: "a1", tokensOut: 10 }] })], 1000), 1000);
    // Only the parent session row exists in `sessions`.
    const rows = s.db.query("SELECT session_key FROM sessions").all() as any[];
    expect(rows.map((r) => r.session_key)).toEqual(["SID"]);
    s.close();
  });

  test("getSubagents returns [] for an unknown session", () => {
    const s = new Store(":memory:");
    expect(s.getSubagents("nope")).toEqual([]);
    s.close();
  });
});

describe("Store activeMs", () => {
  function sess(over: any = {}): any {
    return { id: "h1:1", provider: "claude", pid: 1, hostId: "h1", hostLabel: "H1",
      cwd: "/x", category: "code", startedAt: 500, cpu: 0, memMb: 0,
      providerSessionId: "SID", ...over };
  }
  function rep(sessions: any[], sentAt: number): any {
    return { hostId: "h1", hostLabel: "H1", sentAt, sessions };
  }

  test("accumulates sampleIntervalMs per active sampled tick (cpu>threshold)", () => {
    const s = new Store(":memory:", { sampleIntervalMs: 100 });
    // t=1000 first sample, active (cpu 5 > default 1).
    s.record(rep([sess({ cpu: 5 })], 1000), 1000);
    // t=1050 within interval -> not sampled -> no accrual.
    s.record(rep([sess({ cpu: 5 })], 1050), 1050);
    // t=1100 sampled, active again.
    s.record(rep([sess({ cpu: 5 })], 1100), 1100);
    // t=1200 sampled, idle (cpu 0, no active flag) -> no accrual.
    s.record(rep([sess({ cpu: 0 })], 1200), 1200);
    const got = s.getSession("SID")!.session;
    expect(got.activeMs).toBe(200); // two active sampled ticks * 100ms
    s.close();
  });

  test("active flag rescues cpu=0 ticks (blocked on API)", () => {
    const s = new Store(":memory:", { sampleIntervalMs: 100 });
    s.record(rep([sess({ cpu: 0, active: true })], 1000), 1000);
    expect(s.getSession("SID")!.session.activeMs).toBe(100);
    s.close();
  });

  test("threshold is configurable via constructor/env (MC_ACTIVE_CPU_PCT)", () => {
    // Simulate a higher threshold: cpu 3 should NOT count when threshold is 5.
    const prev = process.env.MC_ACTIVE_CPU_PCT;
    process.env.MC_ACTIVE_CPU_PCT = "5";
    try {
      const s = new Store(":memory:", { sampleIntervalMs: 100 });
      s.record(rep([sess({ cpu: 3 })], 1000), 1000);
      s.record(rep([sess({ cpu: 8 })], 1100), 1100);
      expect(s.getSession("SID")!.session.activeMs).toBe(100); // only the cpu=8 tick
      s.close();
    } finally {
      if (prev === undefined) delete process.env.MC_ACTIVE_CPU_PCT;
      else process.env.MC_ACTIVE_CPU_PCT = prev;
    }
  });

  test("backfillActiveMs computes active_ms from existing raw samples (idempotent)", () => {
    const s = new Store(":memory:", { sampleIntervalMs: 100 });
    // Seed raw samples directly (as if from a pre-activeMs DB), leaving active_ms NULL.
    s.importSession(
      { sessionKey: "OLD", liveId: "h1:9", provider: "claude", hostId: "h1",
        hostLabel: "H1", cwd: "/x", category: "code", startedAt: 0, state: "closed",
        endedAt: 500, lastSeenAt: 500 } as any,
      [
        { sessionKey: "OLD", at: 100, resolution: "raw", cpu: 5, active: 0 },
        { sessionKey: "OLD", at: 200, resolution: "raw", cpu: 0, active: 1 },
        { sessionKey: "OLD", at: 300, resolution: "raw", cpu: 0, active: 0 },
      ] as any,
      [],
    );
    // active_ms should be NULL before backfill.
    const before: any = s.db.query("SELECT active_ms FROM sessions WHERE session_key='OLD'").get();
    expect(before.active_ms).toBeNull();

    s.backfillActiveMs();
    // 2 active samples (cpu>1 OR active=1) * 100ms.
    expect(s.getSession("OLD")!.session.activeMs).toBe(200);

    // Idempotent: a second run does not touch already-set rows.
    s.backfillActiveMs();
    expect(s.getSession("OLD")!.session.activeMs).toBe(200);
    s.close();
  });

  test("backfill does not overwrite a live-accumulated active_ms", () => {
    const s = new Store(":memory:", { sampleIntervalMs: 100 });
    s.record(rep([sess({ cpu: 5 })], 1000), 1000);
    const live = s.getSession("SID")!.session.activeMs;
    s.backfillActiveMs();
    expect(s.getSession("SID")!.session.activeMs).toBe(live);
    s.close();
  });
});
