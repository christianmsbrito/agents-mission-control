import { expect, test, describe } from "bun:test";
import { Hub } from "./hub.ts";
import type { HostReport, LiveMsg } from "@mc/shared";

const report = (hostId: string): HostReport => ({
  hostId,
  hostLabel: hostId,
  sentAt: 0,
  sessions: [],
});

describe("Hub", () => {
  test("subscribe gets initial state then patches", () => {
    const hub = new Hub();
    hub.ingest(report("a"), 1000);
    const msgs: LiveMsg[] = [];
    hub.subscribe((m) => msgs.push(m));
    expect(msgs[0]).toMatchObject({ type: "state" });
    expect((msgs[0] as any).hosts).toHaveLength(1);

    hub.ingest(report("b"), 1100);
    expect(msgs[1]).toMatchObject({ type: "patch", report: { hostId: "b" } });
  });

  test("sweep drops stale hosts and emits offline", () => {
    const hub = new Hub(10_000);
    const msgs: LiveMsg[] = [];
    hub.subscribe((m) => msgs.push(m));
    hub.ingest(report("a"), 1000);
    hub.touch("a", 5000);
    hub.sweep(12_000); // 12000-5000=7000 < stale, keep
    expect(hub.snapshot()).toHaveLength(1);
    hub.sweep(20_000); // 20000-5000=15000 > stale, drop
    expect(hub.snapshot()).toHaveLength(0);
    expect(msgs.at(-1)).toEqual({ type: "offline", hostId: "a" });
  });

  test("unsubscribe stops delivery", () => {
    const hub = new Hub();
    const msgs: LiveMsg[] = [];
    const off = hub.subscribe((m) => msgs.push(m));
    off();
    hub.ingest(report("a"), 1000);
    expect(msgs).toHaveLength(1); // only the initial state
  });

  test("ingest re-resolves category from the live mapping", () => {
    let cats = { byProvider: { codex: "review" } };
    const hub = new Hub(10_000, () => cats);
    const report = {
      hostId: "h1", hostLabel: "h1", sentAt: 0,
      sessions: [{ id: "h1:1", provider: "codex", pid: 1, hostId: "h1", hostLabel: "h1",
        cwd: null, category: "uncategorized", startedAt: 0, cpu: 0, memMb: 0 }],
    };
    hub.ingest(report as any, 0);
    expect(hub.snapshot()[0].sessions[0].category).toBe("review");
    cats = { byProvider: { codex: "research" } };
    hub.ingest(report as any, 0);
    expect(hub.snapshot()[0].sessions[0].category).toBe("research");
  });

  test("setStaleMs changes sweep behavior", () => {
    const hub = new Hub(10_000, () => ({}));
    hub.ingest({ hostId: "h1", hostLabel: "h1", sentAt: 0, sessions: [] } as any, 0);
    hub.setStaleMs(3000);
    hub.sweep(2000); // 2000 < 3000 -> kept
    expect(hub.snapshot().length).toBe(1);
    hub.sweep(3001); // 3001 > 3000 -> dropped
    expect(hub.snapshot()).toEqual([]);
  });

  test("assigns mc:a handles by live pid locator", () => {
    const hub = new Hub(10_000, () => ({}));
    const session = {
      id: "h1:42", provider: "codex", pid: 42, hostId: "h1", hostLabel: "h1",
      cwd: "/repo", category: "review", startedAt: 1000, cpu: 0, memMb: 0,
    };

    hub.ingest({ hostId: "h1", hostLabel: "h1", sentAt: 0, sessions: [session] } as any, 0);
    expect(hub.snapshot()[0].sessions[0].handle).toBe("mc:a1");
    expect(hub.findSessionByHandle("mc:a1")?.id).toBe("h1:42");

    hub.ingest({ hostId: "h1", hostLabel: "h1", sentAt: 1, sessions: [{ ...session, summary: "still same process" }] } as any, 1);
    expect(hub.snapshot()[0].sessions[0].handle).toBe("mc:a1");

    hub.ingest({
      hostId: "h1", hostLabel: "h1", sentAt: 2,
      sessions: [{ ...session, startedAt: 2000 }],
    } as any, 2);
    expect(hub.snapshot()[0].sessions[0].handle).toBe("mc:a1");
    expect(hub.listAliases().map((a) => a.handle)).toEqual(["mc:a1"]);

    hub.ingest({
      hostId: "h1", hostLabel: "h1", sentAt: 3,
      sessions: [{ ...session, id: "h1:43", pid: 43, startedAt: 3000 }],
    } as any, 3);
    expect(hub.snapshot()[0].sessions[0].handle).toBe("mc:a2");
  });

  test("provider-session lookup only falls back to cwd when unambiguous", () => {
    const hub = new Hub(10_000, () => ({}));
    const base = {
      provider: "claude",
      hostId: "h1",
      hostLabel: "h1",
      cwd: "/repo",
      category: "code",
      startedAt: 0,
      cpu: 0,
      memMb: 0,
    };

    hub.ingest({
      hostId: "h1",
      hostLabel: "h1",
      sentAt: 0,
      sessions: [
        { ...base, id: "h1:1", pid: 1, providerSessionId: "claude-1" },
        { ...base, id: "h1:2", pid: 2, providerSessionId: "claude-2" },
      ],
    } as any, 0);

    expect(hub.findSessionByProviderSession("claude", "claude-2", "/repo")?.id).toBe("h1:2");
    expect(hub.findSessionByProviderSession("claude", undefined, "/repo")).toBeUndefined();
    expect(hub.findSessionByProviderSession("claude", "missing", "/repo")).toBeUndefined();

    hub.ingest({
      hostId: "h1",
      hostLabel: "h1",
      sentAt: 1,
      sessions: [{ ...base, id: "h1:1", pid: 1, providerSessionId: "claude-1" }],
    } as any, 1);

    expect(hub.findSessionByProviderSession("claude", undefined, "/repo")?.id).toBe("h1:1");
  });
});
