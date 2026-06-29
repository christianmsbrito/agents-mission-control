import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import type { HostReport } from "@mc/shared";

// configure before importing the server (reads env at import time)
process.env.MC_PORT = String(32_000 + Math.floor(Math.random() * 10_000));
process.env.MC_TOKEN = "secret";
process.env.MC_DB = ":memory:"; // in-memory store; never touch the real ~/.mission-control/mc.db

const { server, store } = await import("./index.ts");
const base = `ws://localhost:${server.port}`;
const httpBase = `http://localhost:${server.port}`;

function open(path: string): Promise<WebSocket> {
  const ws = new WebSocket(base + path);
  return new Promise((res, rej) => {
    ws.onopen = () => res(ws);
    ws.onerror = (e) => rej(e);
  });
}
const next = (ws: WebSocket): Promise<any> =>
  new Promise((res) => {
    ws.onmessage = (e) => res(JSON.parse(String(e.data)));
  });

/** Accumulate every message a socket receives (for asserting >1 event). */
function collect(ws: WebSocket): any[] {
  const got: any[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  return got;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const report: HostReport = { hostId: "h1", hostLabel: "h1", sentAt: 0, sessions: [] };

afterAll(() => {
  void server.stop(true);
});

describe("server ws", () => {
  test("authed reporter flows to live subscriber", async () => {
    const live = await open("/ws/live");
    const state = await next(live);
    expect(state.type).toBe("state");
    const settings = await next(live);
    expect(settings.type).toBe("settings");
    expect(settings.config).toMatchObject({ staleMs: expect.any(Number), summaries: expect.any(Object) });

    const rep = await open("/ws/report");
    rep.send(JSON.stringify({ type: "hello", hostId: "h1", hostLabel: "h1", token: "secret" }));
    const patchP = next(live);
    rep.send(JSON.stringify({ type: "report", report }));
    const patch = await patchP;
    expect(patch).toMatchObject({ type: "patch", report: { hostId: "h1" } });

    const offlineP = next(live);
    rep.close();
    const offline = await offlineP;
    expect(offline).toEqual({ type: "offline", hostId: "h1" });
    live.close();
  });

  test("reported sessions are persisted to the store as running", async () => {
    const rep = await open("/ws/report");
    rep.send(JSON.stringify({ type: "hello", hostId: "persist1", hostLabel: "persist1", token: "secret" }));
    const session = {
      id: "persist1:555", provider: "claude", pid: 555, hostId: "persist1", hostLabel: "persist1",
      cwd: "/persist-repo", category: "code", startedAt: 12345, cpu: 0, memMb: 0, subject: "persisted subject",
    };
    rep.send(JSON.stringify({ type: "report", report: { hostId: "persist1", hostLabel: "persist1", sentAt: 0, sessions: [session] } }));
    await new Promise((r) => setTimeout(r, 50)); // let the report ingest + persist

    const persisted = store.listSessions({ provider: "claude" }).find((s) => s.cwd === "/persist-repo");
    expect(persisted).toBeDefined();
    expect(persisted!.state).toBe("running");
    expect(persisted!.subject).toBe("persisted subject");
    rep.close();
  });

  test("bad token is rejected and never ingests", async () => {
    const rep = await open("/ws/report");
    const closed = new Promise<number>((res) => (rep.onclose = (e) => res(e.code)));
    rep.send(JSON.stringify({ type: "hello", hostId: "evil", hostLabel: "evil", token: "wrong" }));
    expect(await closed).toBe(4001);
  });

  test("kill relays to reporter and publishes a session.killed event", async () => {
    const rep = await open("/ws/report");
    rep.send(JSON.stringify({ type: "hello", hostId: "k1", hostLabel: "k1", token: "secret" }));
    // reporter replies to a kill command with a killed confirmation
    rep.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "kill") rep.send(JSON.stringify({ type: "killed", pid: m.pid, ok: true }));
    };
    // report a session so the server can enrich the event
    const session = {
      id: "k1:4242", provider: "claude", pid: 4242, hostId: "k1", hostLabel: "k1",
      cwd: "/repo", category: "code", startedAt: 0, cpu: 0, memMb: 0, subject: "test subject",
    };
    rep.send(JSON.stringify({ type: "report", report: { hostId: "k1", hostLabel: "k1", sentAt: 0, sessions: [session] } }));
    await new Promise((r) => setTimeout(r, 50)); // let the report ingest

    const events = await open("/ws/events");
    const evP = next(events);
    const live = await open("/ws/live");
    await next(live); // initial state
    live.send(JSON.stringify({ type: "kill", sessionId: "k1:4242" }));

    const ev = await evP;
    expect(ev).toMatchObject({
      type: "session.killed", sessionId: "k1:4242", hostId: "k1", pid: 4242, ok: true,
      provider: "claude", subject: "test subject",
    });
    rep.close();
    live.close();
    events.close();
  });

  test("prompt relays text to reporter and publishes session.prompted", async () => {
    const rep = await open("/ws/report");
    rep.send(JSON.stringify({ type: "hello", hostId: "p1", hostLabel: "p1", token: "secret" }));
    let relayed = "";
    rep.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "prompt") {
        relayed = m.text;
        rep.send(JSON.stringify({ type: "prompted", pid: m.pid, ok: true, commandId: m.commandId }));
      }
    };
    const session = { id: "p1:77", provider: "claude", pid: 77, hostId: "p1", hostLabel: "p1", cwd: "/r", category: "code", startedAt: 0, cpu: 0, memMb: 0 };
    rep.send(JSON.stringify({ type: "report", report: { hostId: "p1", hostLabel: "p1", sentAt: 0, sessions: [session] } }));
    await new Promise((r) => setTimeout(r, 50));

    const events = await open("/ws/events");
    const evP = next(events);
    const live = await open("/ws/live");
    await next(live);
    live.send(JSON.stringify({ type: "prompt", sessionId: "p1:77", text: "run the tests please" }));

    const ev = await evP;
    expect(relayed).toBe("run the tests please");
    expect(ev).toMatchObject({ type: "session.prompted", pid: 77, ok: true, text: "run the tests please" });
    rep.close();
    live.close();
    events.close();
  });

  test("spawn with unknown templateId is a no-op (no relay, no crash)", async () => {
    const rep = await open("/ws/report");
    rep.send(JSON.stringify({ type: "hello", hostId: "sp1", hostLabel: "sp1", token: "secret" }));
    let relayedSpawn = false;
    rep.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "spawn") relayedSpawn = true;
    };
    await new Promise((r) => setTimeout(r, 30)); // let hello register the reporter

    const live = await open("/ws/live");
    await next(live); // initial state
    live.send(JSON.stringify({ type: "spawn", hostId: "sp1", templateId: "does-not-exist" }));
    await new Promise((r) => setTimeout(r, 50)); // give the server a chance to (not) relay

    expect(relayedSpawn).toBe(false);
    rep.close();
    live.close();
  });

  test("spawn relays template to reporter; promptOverride/cwd win over defaults", async () => {
    store.createTemplate({
      id: "tmpl-1", name: "Scout", provider: "claude",
      args: ["--dangerously-skip-permissions"], prompt: "default prompt", cwd: "/default",
      createdAt: Date.now(),
    });
    const rep = await open("/ws/report");
    rep.send(JSON.stringify({ type: "hello", hostId: "sp2", hostLabel: "sp2", token: "secret" }));
    let relayed: any = null;
    rep.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "spawn") relayed = m;
    };
    await new Promise((r) => setTimeout(r, 30)); // let hello register the reporter

    const live = await open("/ws/live");
    await next(live); // initial state
    live.send(JSON.stringify({
      type: "spawn", hostId: "sp2", templateId: "tmpl-1",
      promptOverride: "override prompt", cwd: "/override",
    }));
    await new Promise((r) => setTimeout(r, 50)); // give the server a chance to relay

    expect(relayed).toMatchObject({
      type: "spawn", templateId: "tmpl-1", cmd: "claude",
      args: ["--dangerously-skip-permissions"],
      prompt: "override prompt", cwd: "/override",
    });
    expect(typeof relayed.commandId).toBe("string");
    rep.close();
    live.close();
  });

  test("per-host spawn rate cap drops the 6th spawn in the window", async () => {
    store.createTemplate({
      id: "tmpl-rate", name: "Swarm", provider: "claude",
      args: ["--dangerously-skip-permissions"], createdAt: Date.now(),
    });
    const rep = await open("/ws/report");
    rep.send(JSON.stringify({ type: "hello", hostId: "sp3", hostLabel: "sp3", token: "secret" }));
    let relayedCount = 0;
    rep.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "spawn") relayedCount++;
    };
    await new Promise((r) => setTimeout(r, 30)); // let hello register the reporter

    const live = await open("/ws/live");
    await next(live); // initial state
    for (let i = 0; i < 6; i++) {
      live.send(JSON.stringify({ type: "spawn", hostId: "sp3", templateId: "tmpl-rate" }));
    }
    await new Promise((r) => setTimeout(r, 80)); // let the server process all 6

    expect(relayedCount).toBe(5); // cap is 5 per window; the 6th is dropped
    rep.close();
    live.close();
  });

  test("router API assigns aliases, asks a target, and routes replies back", async () => {
    const rep = await open("/ws/report");
    rep.send(JSON.stringify({ type: "hello", hostId: "r1", hostLabel: "r1", token: "secret" }));

    const prompts: any[] = [];
    let promptCount = 0;
    let resolvePrompt: (() => void) | null = null;
    const nextPrompt = () =>
      new Promise<void>((res) => {
        resolvePrompt = res;
      });
    rep.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "prompt") {
        prompts.push(m);
        promptCount++;
        rep.send(JSON.stringify({ type: "prompted", pid: m.pid, ok: true, commandId: m.commandId }));
        resolvePrompt?.();
      }
    };

    const sessions = [
      { id: "r1:100", provider: "codex", pid: 100, hostId: "r1", hostLabel: "r1", cwd: "/one", category: "review", startedAt: 1000, cpu: 0, memMb: 0 },
      { id: "r1:200", provider: "codex", pid: 200, hostId: "r1", hostLabel: "r1", cwd: "/two", category: "review", startedAt: 2000, cpu: 0, memMb: 0 },
    ];
    rep.send(JSON.stringify({ type: "report", report: { hostId: "r1", hostLabel: "r1", sentAt: 0, sessions } }));
    await new Promise((r) => setTimeout(r, 50));

    const auth = { authorization: "Bearer secret" };
    const agentsRes = await fetch(`${httpBase}/api/agents`, { headers: auth });
    expect(agentsRes.status).toBe(200);
    const agents = (await agentsRes.json()).agents;
    const source = agents.find((a: any) => a.sessionId === "r1:100");
    const target = agents.find((a: any) => a.sessionId === "r1:200");
    expect(source.handle).toMatch(/^mc:a\d+$/);
    expect(target.handle).toMatch(/^mc:a\d+$/);

    let wait = nextPrompt();
    const askRes = await fetch(`${httpBase}/api/ask`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ from: source.handle, to: target.handle, text: "ping target" }),
    });
    expect(askRes.status).toBe(202);
    const ask = await askRes.json();
    await wait;
    expect(prompts[0]).toMatchObject({ pid: 200, commandId: ask.task.id });
    expect(prompts[0].text).toContain("ping target");

    wait = nextPrompt();
    const replyRes = await fetch(`${httpBase}/api/reply`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ taskId: ask.task.id, text: "pong source" }),
    });
    expect(replyRes.status).toBe(200);
    await wait;
    expect(prompts[1]).toMatchObject({ pid: 100, commandId: `${ask.task.id}:reply` });
    expect(prompts[1].text).toContain("pong source");

    await new Promise((r) => setTimeout(r, 20));
    const taskRes = await fetch(`${httpBase}/api/tasks/${ask.task.id}`, { headers: auth });
    const task = (await taskRes.json()).task;
    expect(task).toMatchObject({ id: ask.task.id, state: "replied", promptOk: true, replyDelivered: true });
    expect(promptCount).toBe(2);
    rep.close();
  });

  test("routed tasks persist task.routed and task.replied events to the store", async () => {
    const rep = await open("/ws/report");
    rep.send(JSON.stringify({ type: "hello", hostId: "rt1", hostLabel: "rt1", token: "secret" }));
    rep.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "prompt") rep.send(JSON.stringify({ type: "prompted", pid: m.pid, ok: true, commandId: m.commandId }));
    };

    const sessions = [
      { id: "rt1:100", provider: "codex", providerSessionId: "src-sess", pid: 100, hostId: "rt1", hostLabel: "rt1", cwd: "/one", category: "review", startedAt: 1000, cpu: 0, memMb: 0 },
      { id: "rt1:200", provider: "codex", providerSessionId: "tgt-sess", pid: 200, hostId: "rt1", hostLabel: "rt1", cwd: "/two", category: "review", startedAt: 2000, cpu: 0, memMb: 0 },
    ];
    rep.send(JSON.stringify({ type: "report", report: { hostId: "rt1", hostLabel: "rt1", sentAt: 0, sessions } }));
    await new Promise((r) => setTimeout(r, 50));

    const auth = { authorization: "Bearer secret" };
    const agents = (await (await fetch(`${httpBase}/api/agents`, { headers: auth })).json()).agents;
    const source = agents.find((a: any) => a.sessionId === "rt1:100");
    const target = agents.find((a: any) => a.sessionId === "rt1:200");

    const ask = await (await fetch(`${httpBase}/api/ask`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ from: source.handle, to: target.handle, text: "ping target" }),
    })).json();
    await new Promise((r) => setTimeout(r, 20));

    const routed = store.listEvents({ type: "task.routed" }).find((e) => (e.detail as any)?.taskId === ask.task.id);
    expect(routed).toBeDefined();
    expect(routed!.sessionKey).toBe("tgt-sess"); // target's durable session key
    expect(routed!.detail).toMatchObject({
      taskId: ask.task.id,
      toHandle: target.handle,
      fromHandle: source.handle,
      toKey: "tgt-sess",
      fromKey: "src-sess",
      text: "ping target",
    });

    await (await fetch(`${httpBase}/api/reply`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ taskId: ask.task.id, text: "pong source" }),
    })).json();
    await new Promise((r) => setTimeout(r, 20));

    const replied = store.listEvents({ type: "task.replied" }).find((e) => (e.detail as any)?.taskId === ask.task.id);
    expect(replied).toBeDefined();
    expect(replied!.sessionKey).toBe("tgt-sess");
    expect(replied!.detail).toMatchObject({ taskId: ask.task.id, reply: "pong source", ok: true });
    rep.close();
  });

  describe("HTTP read endpoints", () => {
    // Seed registry rows + samples + events directly through the exported store.
    const now = 1_700_000_000_000;
    // synthetic key with colons; startedAt (=now ms) is floored to whole seconds
    // in the key by sessionKeyOf, so 1700000000000ms -> :1700000000.
    const colonKey = "rd-host:909:1700000000"; // synthetic key with colons

    function seed() {
      const mk = (over: Partial<any>): any => ({
        id: "rd-host:909", provider: "claude", pid: 909, hostId: "rd-host", hostLabel: "rd-host",
        cwd: "/read-repo", category: "code", startedAt: now, cpu: 1, memMb: 10,
        tokensIn: 100, tokensOut: 50, costUsd: 0.01, contextTokens: 1000, contextWindow: 200000,
        active: true, ...over,
      });
      const running = mk({});
      // distinct second session (different cwd/category -> filterable)
      const other = mk({ id: "rd-host:910", pid: 910, cwd: "/other-repo", category: "review", provider: "codex", active: false });
      store.record(
        { hostId: "rd-host", hostLabel: "rd-host", sentAt: 0, sessions: [running, other] },
        now,
      );
      // a sample at a later time so the gate lets it through
      store.record(
        { hostId: "rd-host", hostLabel: "rd-host", sentAt: 0, sessions: [mk({ tokensIn: 200 }), other] },
        now + 120_000,
      );
    }
    seed();

    test("GET /api/sessions?state=running returns { sessions, total }", async () => {
      const res = await fetch(`${httpBase}/api/sessions?state=running`);
      expect(res.status).toBe(200);
      const { sessions: rows, total } = await res.json();
      expect(Array.isArray(rows)).toBe(true);
      expect(typeof total).toBe("number");
      const mine = rows.find((r: any) => r.sessionKey === colonKey);
      expect(mine).toBeDefined();
      expect(mine.state).toBe("running");
      expect(rows.every((r: any) => r.state === "running")).toBe(true);
    });

    test("GET /api/sessions filters by provider", async () => {
      const res = await fetch(`${httpBase}/api/sessions?provider=codex`);
      const { sessions: rows } = await res.json();
      expect(rows.every((r: any) => r.provider === "codex")).toBe(true);
      expect(rows.find((r: any) => r.cwd === "/other-repo")).toBeDefined();
    });

    test("GET /api/sessions?minTokens=… filters but keeps running sessions; total reflects filter", async () => {
      // The seeded rows are state=running, so even with a high floor they survive (running exempt).
      const res = await fetch(`${httpBase}/api/sessions?minTokens=1000000`);
      expect(res.status).toBe(200);
      const { sessions: rows, total } = await res.json();
      expect(typeof total).toBe("number");
      expect(rows.find((r: any) => r.sessionKey === colonKey)).toBeDefined(); // running, exempt
    });

    test("GET /api/sessions paginates with limit/offset; total is the full count", async () => {
      const first = await (await fetch(`${httpBase}/api/sessions?limit=1&offset=0`)).json();
      expect(first.sessions.length).toBe(1);
      expect(first.total).toBeGreaterThanOrEqual(2);
      const second = await (await fetch(`${httpBase}/api/sessions?limit=1&offset=1`)).json();
      expect(second.sessions.length).toBe(1);
      expect(second.sessions[0].sessionKey).not.toBe(first.sessions[0].sessionKey);
      expect(second.total).toBe(first.total);
    });

    test("GET /api/sessions/:key (colon-containing key) returns {session, events}", async () => {
      const res = await fetch(`${httpBase}/api/sessions/${encodeURIComponent(colonKey)}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.sessionKey).toBe(colonKey);
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.some((e: any) => e.type === "session.started")).toBe(true);
    });

    test("GET /api/sessions/:key unknown -> 404", async () => {
      const res = await fetch(`${httpBase}/api/sessions/${encodeURIComponent("does:not:exist")}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    });

    test("GET /api/sessions/:key/samples returns sample rows", async () => {
      const res = await fetch(`${httpBase}/api/sessions/${encodeURIComponent(colonKey)}/samples`);
      expect(res.status).toBe(200);
      const rows = await res.json();
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].sessionKey).toBe(colonKey);
    });

    test("GET /api/events returns events; ?type filters", async () => {
      const all = await (await fetch(`${httpBase}/api/events`)).json();
      expect(Array.isArray(all)).toBe(true);
      expect(all.length).toBeGreaterThanOrEqual(1);

      const started = await (await fetch(`${httpBase}/api/events?type=session.started`)).json();
      expect(started.every((e: any) => e.type === "session.started")).toBe(true);
      expect(started.find((e: any) => e.sessionKey === colonKey)).toBeDefined();
    });

    test("GET /api/sessions?limit=abc does not 500 (NaN ignored)", async () => {
      const res = await fetch(`${httpBase}/api/sessions?limit=abc`);
      expect(res.status).toBe(200);
      expect(Array.isArray((await res.json()).sessions)).toBe(true);
    });

    test("GET /api/sessions?limit=999999 is clamped and OK", async () => {
      const res = await fetch(`${httpBase}/api/sessions?limit=999999&offset=-5`);
      expect(res.status).toBe(200);
      expect(Array.isArray((await res.json()).sessions)).toBe(true);
    });

    test("non-api path still hits the SPA static fallback (not swallowed by /api)", async () => {
      const res = await fetch(`${httpBase}/some/spa/route`);
      expect(res.status).toBe(200); // index.html fallback or build hint, never JSON 404
    });

    test("GET /api/sessions?q=… searches; ?sort=cost orders", async () => {
      const res = await fetch(`${httpBase}/api/sessions?q=read-repo`);
      expect(res.status).toBe(200);
      const { sessions: rows } = await res.json();
      expect(rows.find((r: any) => r.cwd === "/read-repo")).toBeDefined();
      expect(rows.every((r: any) => r.cwd === "/read-repo")).toBe(true);
      const sorted = await (await fetch(`${httpBase}/api/sessions?sort=cost&order=desc`)).json();
      expect(Array.isArray(sorted.sessions)).toBe(true);
    });

    test("GET /api/facets returns dimension buckets with counts", async () => {
      const res = await fetch(`${httpBase}/api/facets`);
      expect(res.status).toBe(200);
      const f = await res.json();
      expect(Array.isArray(f.providers)).toBe(true);
      expect(f.providers.find((p: any) => p.value === "claude")).toBeDefined();
      expect(f.providers.find((p: any) => p.value === "codex")).toBeDefined();
      expect(Array.isArray(f.hosts)).toBe(true);
    });

    test("/api/sessions/:key/quests exposes the agent's TodoWrite work items", async () => {
      // Seed a session carrying workItems through the live record path.
      // startedAt (=now ms) floored to whole seconds in the synthetic key.
      const wkKey = "wk-host:1:1700000000";
      store.record(
        { hostId: "wk-host", hostLabel: "wk-host", sentAt: 0, sessions: [{
          id: "wk-host:1", provider: "claude", pid: 1, hostId: "wk-host", hostLabel: "wk-host",
          cwd: "/wk", category: "code", startedAt: now, cpu: 0, memMb: 0,
          workItems: [
            { itemKey: "q1", subject: "build thing", status: "in_progress", position: 0 },
            { itemKey: "q2", subject: "test thing", status: "pending", position: 1 },
          ],
        }] },
        now,
      );
      const detail = await (await fetch(`${httpBase}/api/sessions/${encodeURIComponent(wkKey)}/quests`)).json();
      expect(detail.map((q: any) => q.itemKey).sort()).toEqual(["q1", "q2"]);
    });

    test("managed quests: POST /api/quests creates, GET lists, PATCH/DELETE mutate", async () => {
      const created = await (await fetch(`${httpBase}/api/quests`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "ship the thing", sessionKey: "wk-host:1:1700000000000" }),
      })).json();
      expect(created.id).toBeTruthy();
      expect(created.status).toBe("pending");

      const list = await (await fetch(`${httpBase}/api/quests?status=pending`)).json();
      expect(list.find((q: any) => q.id === created.id)).toBeDefined();

      const patched = await (await fetch(`${httpBase}/api/quests/${created.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      })).json();
      expect(patched.ok).toBe(true);

      const del = await (await fetch(`${httpBase}/api/quests/${created.id}`, { method: "DELETE" })).json();
      expect(del.ok).toBe(true);
    });

    test("GET /api/stats/timeseries returns series; bad bucket -> 400", async () => {
      const ok = await fetch(`${httpBase}/api/stats/timeseries?since=0&until=${now + 1000000}&bucket=day`);
      expect(ok.status).toBe(200);
      const ts = await ok.json();
      expect(ts.bucket).toBe("day");
      expect(Array.isArray(ts.series)).toBe(true);
      const bad = await fetch(`${httpBase}/api/stats/timeseries?since=0&until=10&bucket=year`);
      expect(bad.status).toBe(400);
      const missing = await fetch(`${httpBase}/api/stats/timeseries?bucket=day`);
      expect(missing.status).toBe(400);
    });
  });

  test("task.routed with no source omits fromHandle/fromKey", async () => {
    const rep = await open("/ws/report");
    rep.send(JSON.stringify({ type: "hello", hostId: "rt2", hostLabel: "rt2", token: "secret" }));
    rep.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "prompt") rep.send(JSON.stringify({ type: "prompted", pid: m.pid, ok: true, commandId: m.commandId }));
    };
    const session = { id: "rt2:300", provider: "codex", providerSessionId: "nf-tgt", pid: 300, hostId: "rt2", hostLabel: "rt2", cwd: "/three", category: "review", startedAt: 3000, cpu: 0, memMb: 0 };
    rep.send(JSON.stringify({ type: "report", report: { hostId: "rt2", hostLabel: "rt2", sentAt: 0, sessions: [session] } }));
    await new Promise((r) => setTimeout(r, 50));

    const auth = { authorization: "Bearer secret" };
    const agents = (await (await fetch(`${httpBase}/api/agents`, { headers: auth })).json()).agents;
    const target = agents.find((a: any) => a.sessionId === "rt2:300");

    const ask = await (await fetch(`${httpBase}/api/ask`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ to: target.handle, text: "no source here" }), // no `from`
    })).json();
    await new Promise((r) => setTimeout(r, 20));

    const routed = store.listEvents({ type: "task.routed" }).find((e) => (e.detail as any)?.taskId === ask.task.id);
    expect(routed).toBeDefined();
    const detail = routed!.detail as any;
    expect(detail).toMatchObject({ taskId: ask.task.id, toHandle: target.handle, toKey: "nf-tgt", text: "no source here" });
    expect("fromHandle" in detail).toBe(false);
    expect("fromKey" in detail).toBe(false);
    rep.close();
  });

  test("lord create/read are public — no token required", async () => {
    // No auth header: creating a lord succeeds (same open trust model as the
    // rest of the API and /ws/live).
    const created = await fetch(`${httpBase}/api/templates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Code Review", provider: "codex" }),
    });
    expect(created.status).toBe(200);
    expect((await created.json()).id).toBe("code-review");

    const list = await (await fetch(`${httpBase}/api/templates`)).json();
    expect(list.some((l: any) => l.id === "code-review")).toBe(true);

    const one = await (await fetch(`${httpBase}/api/templates/code-review`)).json();
    expect(one.id).toBe("code-review");

    const missing = await fetch(`${httpBase}/api/templates/nope`);
    expect(missing.status).toBe(404);

    // bad input still validated (400, not a silent create)
    const bad = await fetch(`${httpBase}/api/templates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "codex" }), // missing name
    });
    expect(bad.status).toBe(400);
  });

  test("troop.closed is published when a templated session ends", async () => {
    const rep = await open("/ws/report");
    rep.send(JSON.stringify({ type: "hello", hostId: "tc1", hostLabel: "tc1", token: "secret" }));
    await new Promise((r) => setTimeout(r, 30));
    const troop = {
      id: "tc1:900", provider: "codex", pid: 900, hostId: "tc1", hostLabel: "tc1",
      cwd: "/repo", category: "code", startedAt: 1000, cpu: 0, memMb: 0,
      subject: "review the diff", summary: "did the review", costUsd: 0.5, tokensIn: 1000, tokensOut: 200,
      templateId: "code-review",
    };
    // tick 1: troop present (establishes prev snapshot)
    rep.send(JSON.stringify({ type: "report", report: { hostId: "tc1", hostLabel: "tc1", sentAt: 0, sessions: [troop] } }));
    await new Promise((r) => setTimeout(r, 50));

    const events = await open("/ws/events");
    const evP = next(events);
    // tick 2: troop gone -> closed -> troop.closed emitted
    rep.send(JSON.stringify({ type: "report", report: { hostId: "tc1", hostLabel: "tc1", sentAt: 1, sessions: [] } }));

    const ev = await evP;
    expect(ev).toMatchObject({
      type: "troop.closed", templateId: "code-review", sessionId: "tc1:900",
      provider: "codex", subject: "review the diff", summary: "did the review",
      costUsd: 0.5, tokensIn: 1000, tokensOut: 200,
    });
    expect(typeof ev.durationMs).toBe("number");
    rep.close();
    events.close();
  });

  test("template.deleted is published when a template is deleted", async () => {
    await fetch(`${httpBase}/api/templates`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Doomed", provider: "claude" }),
    });
    const events = await open("/ws/events");
    const evP = next(events);
    const del = await fetch(`${httpBase}/api/templates/doomed`, { method: "DELETE", headers: { "content-type": "application/json" } });
    expect((await del.json()).ok).toBe(true);
    const ev = await evP;
    expect(ev).toMatchObject({ type: "template.deleted", templateId: "doomed", name: "Doomed" });
    events.close();
  });

  test("session.started/attention/errored publish from report diffs", async () => {
    const rep = await open("/ws/report");
    rep.send(JSON.stringify({ type: "hello", hostId: "ev1", hostLabel: "ev1", token: "secret" }));
    await sleep(30);
    const events = await open("/ws/events");
    const got = collect(events);
    const base = { provider: "claude", hostId: "ev1", hostLabel: "ev1", cwd: "/r", category: "code", startedAt: 1000, cpu: 0, memMb: 0 };
    rep.send(JSON.stringify({ type: "report", report: { hostId: "ev1", hostLabel: "ev1", sentAt: 0, sessions: [{ ...base, id: "ev1:1", pid: 1 }] } }));
    await sleep(40);
    rep.send(JSON.stringify({ type: "report", report: { hostId: "ev1", hostLabel: "ev1", sentAt: 1, sessions: [{ ...base, id: "ev1:1", pid: 1, attention: true, ask: "need approval", errored: true, errorTransient: true }] } }));
    await sleep(40);
    const types = got.map((e) => e.type);
    expect(types).toContain("session.started");
    expect(types).toContain("session.attention");
    expect(types).toContain("session.errored");
    expect(got.find((e) => e.type === "session.attention")).toMatchObject({ sessionId: "ev1:1", ask: "need approval" });
    expect(got.find((e) => e.type === "session.errored")).toMatchObject({ sessionId: "ev1:1", transient: true });
    rep.close();
    events.close();
  });

  test("quest.completed publishes when a work item flips to completed", async () => {
    const rep = await open("/ws/report");
    rep.send(JSON.stringify({ type: "hello", hostId: "qc1", hostLabel: "qc1", token: "secret" }));
    await sleep(30);
    const events = await open("/ws/events");
    const got = collect(events);
    const s = (status: string) => ({ id: "qc1:1", provider: "claude", pid: 1, hostId: "qc1", hostLabel: "qc1", cwd: "/r", category: "code", startedAt: 1, cpu: 0, memMb: 0, workItems: [{ itemKey: "q1", subject: "do it", status, position: 0 }] });
    rep.send(JSON.stringify({ type: "report", report: { hostId: "qc1", hostLabel: "qc1", sentAt: 0, sessions: [s("in_progress")] } }));
    await sleep(40);
    rep.send(JSON.stringify({ type: "report", report: { hostId: "qc1", hostLabel: "qc1", sentAt: 1, sessions: [s("completed")] } }));
    await sleep(40);
    expect(got.find((e) => e.type === "quest.completed")).toMatchObject({ itemKey: "q1", questSubject: "do it" });
    rep.close();
    events.close();
  });

  test("host.online on connect, host.offline on disconnect", async () => {
    const events = await open("/ws/events");
    const got = collect(events);
    const rep = await open("/ws/report");
    rep.send(JSON.stringify({ type: "hello", hostId: "host-ev", hostLabel: "My Mac", token: "secret" }));
    await sleep(40);
    expect(got.find((e) => e.type === "host.online")).toMatchObject({ hostId: "host-ev", hostLabel: "My Mac" });
    rep.close();
    await sleep(60);
    expect(got.find((e) => e.type === "host.offline")).toMatchObject({ hostId: "host-ev" });
    events.close();
  });

  test("template.created + template.updated publish", async () => {
    const events = await open("/ws/events");
    const got = collect(events);
    await fetch(`${httpBase}/api/templates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ev Tmpl", provider: "claude" }) });
    await sleep(30);
    await fetch(`${httpBase}/api/templates/ev-tmpl`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ev Tmpl v2" }) });
    await sleep(30);
    expect(got.find((e) => e.type === "template.created")).toMatchObject({ templateId: "ev-tmpl", name: "Ev Tmpl" });
    expect(got.find((e) => e.type === "template.updated")).toMatchObject({ templateId: "ev-tmpl" });
    events.close();
  });
});
