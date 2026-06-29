# Backend UI-Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the query plane so a revamped frontend (live-first + dashboards + drill-down + unified search + RPG quests) has every data shape it needs, with zero schema migration risk and the live board untouched.

**Architecture:** The `sessions` table is already the unified live+history store (running rows are upserted each tick). We add: search/sort to `/api/sessions`; new `/api/facets` and `/api/stats/timeseries` endpoints; and a passive "work-item" (Quest) pipeline sourced from Claude's `TodoWrite` todos, persisted in a new additive `work_items` table. All store logic is pure SQL → unit-tested on `:memory:`. All server `store.*` calls are try/catch-guarded (best-effort edge contract).

**Tech Stack:** Bun, TypeScript (`.ts` import extensions), `bun:sqlite`, `bun test`. Tests are `*.test.ts` colocated with source.

**Design doc:** `docs/plans/2026-06-19-backend-ui-readiness-design.md`

**Branch:** `feat/backend-ui-readiness` (already created & checked out).

**Conventions to honor:**
- Pure-function-first; side effects (fs/sockets/ps) at edges. New store methods bind params (never string-interpolate) — see existing `sessionsWhere` (`store.ts:788`).
- `enrich()` must never throw to caller (`collect.ts:36-40` wraps it; match that).
- Reference files with exact paths. Run `bunx tsc` for typecheck (no lint script).
- Commit after each green task.

---

## Task 1: `WorkItem` type + `workItems` on shared types

**Files:**
- Modify: `packages/shared/src/types.ts` (add `WorkItem`; add `workItems?` to `Session` ~line 63 and `PersistedSession` ~line 210)

**Step 1: Add the type + fields**

In `packages/shared/src/types.ts`, add near the top-level types (before `Session` or after it):

```ts
/** A single kanban-style work unit ("Quest") within a session. Sourced passively
 * from provider todo lists (currently Claude/OpenClaw TodoWrite). */
export type WorkItem = {
  /** Stable per-session id: content hash (TodoWrite rewrites the whole list, no native id). */
  itemKey: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  /** TodoWrite "activeForm" (gerund phrasing shown while in progress). */
  activeForm?: string;
  /** Order within the list as last reported. */
  position?: number;
};
```

Add to `Session` (after `toolsUsed?: string[];` at `types.ts:63`):

```ts
  /** Current kanban work units, when the provider exposes a todo list. */
  workItems?: WorkItem[];
```

Add to `PersistedSession` (after `toolsUsed?: string[];` at `types.ts:206`) — *optional, not persisted on the row itself; populated by quest endpoints when joined:*

> Actually do NOT add `workItems` to `PersistedSession`. Quests are a separate table/endpoint. Leave `PersistedSession` unchanged. (Recording this so the executor doesn't add it.)

**Step 2: Typecheck**

Run: `bunx tsc`
Expected: PASS (no usages yet).

**Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): WorkItem type + Session.workItems"
```

---

## Task 2: Extend `Enrichment` to carry `workItems`

**Files:**
- Modify: `packages/reporter/src/providers/types.ts:14-34` (add `"workItems"` to the `Pick`)

**Step 1: Add field**

In the `Pick<Session, ...>` union in `packages/reporter/src/providers/types.ts`, add `| "workItems"` (e.g. after `| "toolsUsed"`).

**Step 2: Typecheck**

Run: `bunx tsc`
Expected: PASS.

**Step 3: Commit**

```bash
git add packages/reporter/src/providers/types.ts
git commit -m "feat(reporter): Enrichment can carry workItems"
```

---

## Task 3: Extract `TodoWrite` todos in the Claude transcript parser

**Files:**
- Modify: `packages/reporter/src/providers/claude.ts` (`parseClaudeTranscript`, ~line 42-167)
- Test: `packages/reporter/src/providers/claude.test.ts` (add cases; create if absent)

TodoWrite tool calls appear as `content[]` entries: `{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content, status, activeForm }] } }` where `status ∈ "pending"|"in_progress"|"completed"`. The transcript may contain many TodoWrite calls (the list is rewritten each time) — **use the LAST one** as the current board.

**Step 1: Write the failing test**

Add to `packages/reporter/src/providers/claude.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseClaudeTranscript } from "./claude.ts";

test("parseClaudeTranscript: extracts the latest TodoWrite list as workItems", () => {
  const lines = [
    { type: "assistant", message: { id: "m1", role: "assistant", content: [
      { type: "tool_use", name: "TodoWrite", input: { todos: [
        { content: "first", status: "pending", activeForm: "doing first" },
      ] } },
    ] } },
    { type: "assistant", message: { id: "m2", role: "assistant", content: [
      { type: "tool_use", name: "TodoWrite", input: { todos: [
        { content: "first", status: "completed", activeForm: "doing first" },
        { content: "second", status: "in_progress", activeForm: "doing second" },
      ] } },
    ] } },
  ].map((o) => JSON.stringify(o)).join("\n");

  const e = parseClaudeTranscript(lines);
  expect(e.workItems).toBeDefined();
  expect(e.workItems!.length).toBe(2);
  expect(e.workItems![0]).toMatchObject({ subject: "first", status: "completed", position: 0 });
  expect(e.workItems![1]).toMatchObject({ subject: "second", status: "in_progress", position: 1 });
  // itemKey stable & content-derived: same content => same key across the two writes.
  expect(typeof e.workItems![0].itemKey).toBe("string");
  expect(e.workItems![0].itemKey.length).toBeGreaterThan(0);
});

test("parseClaudeTranscript: no TodoWrite => no workItems", () => {
  const lines = JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant",
    content: [{ type: "text", text: "hi" }] } });
  expect(parseClaudeTranscript(lines).workItems).toBeUndefined();
});
```

**Step 2: Run, verify it fails**

Run: `bun test packages/reporter/src/providers/claude.test.ts -t "TodoWrite"`
Expected: FAIL (`workItems` undefined).

**Step 3: Implement**

In `parseClaudeTranscript`:

1. Add a stable content-hash helper at module scope (top of `claude.ts`):

```ts
/** Tiny stable string hash (djb2) -> base36. For WorkItem.itemKey (no crypto needed). */
function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
```

2. Add a local accumulator near the other `let`s (after `const tools = new Set<string>();`, line 54):

```ts
  let latestTodos: any[] | undefined; // last TodoWrite.input.todos wins
```

3. Inside the `tool_use` branch (after the existing `if (c?.type === "tool_use" ...)` handling, within the same `for (const c of msg.content)` loop, ~line 121-138), capture TodoWrite payload. Simplest: add a dedicated check right after `if (c?.type === "tool_use" && typeof c.name === "string") {`:

```ts
          if (c.name === "TodoWrite" && Array.isArray(c.input?.todos)) {
            latestTodos = c.input.todos;
          }
```

(Leave the existing `tools.add("TodoWrite")` path intact — it still records the tool use.)

4. After the entries loop, before `return out;` (~line 165), map todos → workItems:

```ts
  if (latestTodos && latestTodos.length) {
    const items = latestTodos
      .filter((t) => t && typeof t.content === "string")
      .map((t, i) => {
        const status = ["pending", "in_progress", "completed"].includes(t.status)
          ? t.status : "pending";
        const wi: NonNullable<Enrichment["workItems"]>[number] = {
          itemKey: hashKey(t.content),
          subject: t.content,
          status,
          position: i,
        };
        if (typeof t.activeForm === "string") wi.activeForm = t.activeForm;
        return wi;
      });
    if (items.length) out.workItems = items;
  }
```

**Step 4: Run, verify pass**

Run: `bun test packages/reporter/src/providers/claude.test.ts`
Expected: PASS (new + existing tests).

**Step 5: Commit**

```bash
git add packages/reporter/src/providers/claude.ts packages/reporter/src/providers/claude.test.ts
git commit -m "feat(reporter): extract latest TodoWrite todos as workItems"
```

> `collect.ts` needs no change: `workItems` is in `enr` (it's not `summaryInput`/`subjectInput`) so the existing spread `...enr` (`collect.ts:56`) carries it onto `Session`, and from there into `HostReport` → `/ws/live` automatically. OpenClaw inherits this via `parseClaudeTranscript`.

---

## Task 4: `work_items` table + capture in `store.record()`

**Files:**
- Modify: `packages/server/src/store.ts` (migrate ~294-323; prepared stmt ~210-292; `record()` ~503-614)
- Test: `packages/server/src/store.test.ts`

**Step 1: Write the failing test**

Add to `packages/server/src/store.test.ts` (follow existing patterns for building a `HostReport`; a minimal helper):

```ts
import { test, expect } from "bun:test";
import { Store } from "./store.ts";
import type { HostReport, Session } from "@mc/shared";

function rep(sessions: Session[], sentAt = 1000): HostReport {
  return { hostId: "h1", hostLabel: "H1", sentAt, sessions };
}
function sess(over: Partial<Session> = {}): Session {
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

  // Next tick: "a" completed, "b" gone from the list entirely.
  s.record(rep([sess({ workItems: [
    { itemKey: "a", subject: "alpha", status: "completed", position: 0 },
  ] })], 2000), 2000);

  q = s.getQuests("SID");
  expect(q.find((x) => x.itemKey === "a")!.status).toBe("completed");
  // "b" retains its last-known status (not deleted).
  expect(q.find((x) => x.itemKey === "b")!.status).toBe("pending");
  s.close();
});
```

**Step 2: Run, verify it fails**

Run: `bun test packages/server/src/store.test.ts -t "workItems"`
Expected: FAIL (`getQuests` not a function).

**Step 3: Implement**

(a) In `migrate()` (`store.ts:294`), add to the `CREATE TABLE` exec block:

```sql
      CREATE TABLE IF NOT EXISTS work_items (
        session_key TEXT NOT NULL, item_key TEXT NOT NULL,
        subject TEXT NOT NULL, status TEXT NOT NULL, active_form TEXT,
        position INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_key, item_key)
      );
      CREATE INDEX IF NOT EXISTS ix_work_items_key ON work_items(session_key);
      CREATE INDEX IF NOT EXISTS ix_work_items_status ON work_items(status);
```

(b) Add a prepared statement field declaration near the others (`store.ts:194`):

```ts
  private readonly upsertWorkItem;
```

(c) Initialize it in the constructor (after `applyEnrich`, ~line 292):

```ts
    this.upsertWorkItem = this.db.query(
      `INSERT INTO work_items (session_key, item_key, subject, status, active_form, position, created_at, updated_at)
       VALUES ($session_key, $item_key, $subject, $status, $active_form, $position, $now, $now)
       ON CONFLICT(session_key, item_key) DO UPDATE SET
         subject = excluded.subject, status = excluded.status,
         active_form = excluded.active_form, position = excluded.position,
         updated_at = excluded.updated_at`,
    );
```

(d) In `record()`, inside the per-session loop (after the `upsertSession.run({...})` call, ~line 546, still inside `for (const [key, session] of current)` and the transaction), upsert work items:

```ts
        for (const wi of session.workItems ?? []) {
          this.upsertWorkItem.run({
            $session_key: key,
            $item_key: wi.itemKey,
            $subject: wi.subject,
            $status: wi.status,
            $active_form: wi.activeForm ?? null,
            $position: wi.position ?? null,
            $now: now,
          });
        }
```

(e) Add read methods + a row mapper in the Read API section (after `getSession`, ~line 835):

```ts
  /** Work items ("quests") for one session, ordered by position then created. */
  getQuests(sessionKey: string): WorkItem[] {
    const rows = this.db
      .query("SELECT * FROM work_items WHERE session_key = ? ORDER BY position ASC, created_at ASC")
      .all(sessionKey) as any[];
    return rows.map((r) => this.rowToWorkItem(r));
  }

  private rowToWorkItem(r: any): WorkItem {
    return {
      itemKey: r.item_key,
      subject: r.subject,
      status: r.status,
      activeForm: r.active_form ?? undefined,
      position: r.position ?? undefined,
    };
  }
```

Add `WorkItem` to the `@mc/shared` import at the top of `store.ts:2-11`.

**Step 4: Run, verify pass**

Run: `bun test packages/server/src/store.test.ts -t "workItems"`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/store.ts packages/server/src/store.test.ts
git commit -m "feat(store): work_items table + capture in record() + getQuests"
```

---

## Task 5: Cross-session quest board query (`listQuests`)

**Files:**
- Modify: `packages/server/src/store.ts`
- Test: `packages/server/src/store.test.ts`

**Step 1: Write the failing test**

```ts
test("listQuests: cross-session board filters by status/provider, joins session context", () => {
  const s = new Store(":memory:");
  s.record(rep([sess({ workItems: [
    { itemKey: "a", subject: "alpha", status: "in_progress", position: 0 },
  ] })], 1000), 1000);
  s.record(rep([{ ...sess({ id: "h1:2", pid: 2, providerSessionId: "SID2", provider: "codex",
    workItems: [{ itemKey: "c", subject: "gamma", status: "completed", position: 0 }] }) }], 1000), 1000);

  const all = s.listQuests({});
  expect(all.length).toBe(2);
  // Joined context present.
  expect(all[0]).toHaveProperty("sessionKey");
  expect(all[0]).toHaveProperty("provider");

  const inProg = s.listQuests({ status: "in_progress" });
  expect(inProg.map((q) => q.itemKey)).toEqual(["a"]);

  const codex = s.listQuests({ provider: "codex" });
  expect(codex.map((q) => q.itemKey)).toEqual(["c"]);
  s.close();
});
```

**Step 2: Run, verify it fails**

Run: `bun test packages/server/src/store.test.ts -t "listQuests"`
Expected: FAIL.

**Step 3: Implement**

Add a filter type near `SessionFilter` (`store.ts:28`):

```ts
export type QuestFilter = {
  status?: "pending" | "in_progress" | "completed";
  provider?: string;
  category?: string;
  sessionState?: PersistedSessionState;
  limit?: number;
};

/** A work item enriched with its session's identity, for the cross-session board. */
export type QuestRow = WorkItem & {
  sessionKey: string;
  provider: string;
  category: string;
  displayName?: string;
  hostLabel: string;
  sessionState: PersistedSessionState;
  updatedAt: number;
};
```

Add the method (Read API section):

```ts
  /** Cross-session quest board: work items joined to their session, newest-updated first. */
  listQuests(filter: QuestFilter = {}): QuestRow[] {
    const where: string[] = [];
    const params: any[] = [];
    const add = (clause: string, value: unknown) => { where.push(clause); params.push(value); };
    if (filter.status != null) add("w.status = ?", filter.status);
    if (filter.provider != null) add("s.provider = ?", filter.provider);
    if (filter.category != null) add("s.category = ?", filter.category);
    if (filter.sessionState != null) add("s.state = ?", filter.sessionState);
    const limit = Math.min(2000, filter.limit ?? 500);
    const sql =
      `SELECT w.*, s.provider, s.category, s.display_name, s.host_label, s.state AS session_state
       FROM work_items w JOIN sessions s ON s.session_key = w.session_key` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY w.updated_at DESC LIMIT ?`;
    const rows = this.db.query(sql).all(...params, limit) as any[];
    return rows.map((r) => ({
      ...this.rowToWorkItem(r),
      sessionKey: r.session_key,
      provider: r.provider,
      category: r.category,
      displayName: r.display_name ?? undefined,
      hostLabel: r.host_label,
      sessionState: r.session_state,
      updatedAt: r.updated_at,
    }));
  }
```

**Step 4: Run, verify pass**

Run: `bun test packages/server/src/store.test.ts -t "listQuests"`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/store.ts packages/server/src/store.test.ts
git commit -m "feat(store): listQuests cross-session board"
```

---

## Task 6: `q` search + `sort`/`order` on session list/count

**Files:**
- Modify: `packages/server/src/store.ts` (`SessionFilter` ~17-28; `sessionsWhere` ~788; `listSessions` ~807)
- Test: `packages/server/src/store.test.ts`

**Step 1: Write the failing test**

```ts
test("listSessions: q ANDs terms across fields; sort/order with NULLS LAST", () => {
  const s = new Store(":memory:");
  s.record(rep([
    sess({ id: "h1:1", pid: 1, providerSessionId: "k1", subject: "refactor auth", costUsd: 5 }),
    sess({ id: "h1:2", pid: 2, providerSessionId: "k2", subject: "auth tests", displayName: "scout", costUsd: 1 }),
    sess({ id: "h1:3", pid: 3, providerSessionId: "k3", subject: "unrelated", costUsd: undefined }),
  ], 1000), 1000);

  // single term
  expect(s.listSessions({ q: "auth" }).map((x) => x.sessionKey).sort()).toEqual(["k1", "k2"]);
  // multi-word ANDs (both must match somewhere)
  expect(s.listSessions({ q: "auth scout" }).map((x) => x.sessionKey)).toEqual(["k2"]);
  // sort by cost desc, nulls last
  const byCost = s.listSessions({ sort: "cost", order: "desc" }).map((x) => x.sessionKey);
  expect(byCost.slice(0, 2)).toEqual(["k1", "k2"]);
  expect(byCost[2]).toBe("k3"); // null cost sinks
  // count respects q
  expect(s.countSessions({ q: "auth" })).toBe(2);
  s.close();
});
```

**Step 2: Run, verify it fails**

Run: `bun test packages/server/src/store.test.ts -t "q ANDs terms"`
Expected: FAIL (`q`/`sort` not honored).

**Step 3: Implement**

(a) Extend `SessionFilter` (`store.ts:17-28`):

```ts
  q?: string;
  sort?: SessionSort;
  order?: "asc" | "desc";
```

Add the sort enum + column map above the class (near `SessionFilter`):

```ts
export type SessionSort = "lastSeen" | "started" | "cost" | "tokens" | "context";

const SESSION_SORT_COLUMNS: Record<SessionSort, string> = {
  lastSeen: "last_seen_at",
  started: "started_at",
  cost: "cost_usd",
  tokens: "(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)+COALESCE(tokens_cache_read,0)+COALESCE(tokens_cache_write,0))",
  context: "peak_context_tokens",
};
```

(b) In `sessionsWhere` (`store.ts:788`), add `q` handling before the return:

```ts
    if (filter.q != null && filter.q.trim() !== "") {
      const fields = ["display_name", "subject", "summary", "cwd", "handle", "provider", "model"];
      for (const term of filter.q.trim().split(/\s+/)) {
        const ors = fields.map((f) => `${f} LIKE ?`).join(" OR ");
        where.push(`(${ors})`);
        for (let i = 0; i < fields.length; i++) params.push(`%${term}%`);
      }
    }
```

(c) Rewrite `listSessions` ORDER BY (`store.ts:811`):

```ts
  listSessions(filter: SessionFilter = {}): PersistedSession[] {
    const { clause, params } = this.sessionsWhere(filter);
    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    const col = SESSION_SORT_COLUMNS[filter.sort ?? "lastSeen"] ?? "last_seen_at";
    const dir = filter.order === "asc" ? "ASC" : "DESC";
    const sql = `SELECT * FROM sessions${clause} ORDER BY ${col} ${dir} NULLS LAST, started_at DESC LIMIT ? OFFSET ?`;
    const rows = this.db.query(sql).all(...params, limit, offset) as any[];
    return rows.map((r) => this.rowToSession(r));
  }
```

> `col` comes only from the whitelist map (never from raw user input), so interpolating it is injection-safe. The default `?? "last_seen_at"` guards an out-of-range key.

**Step 4: Run, verify pass**

Run: `bun test packages/server/src/store.test.ts`
Expected: PASS (all store tests).

**Step 5: Commit**

```bash
git add packages/server/src/store.ts packages/server/src/store.test.ts
git commit -m "feat(store): q search + sort/order on listSessions"
```

---

## Task 7: `facets()` (self-excluding)

**Files:**
- Modify: `packages/server/src/store.ts`
- Test: `packages/server/src/store.test.ts`

**Step 1: Write the failing test**

```ts
test("facets: self-excluding — provider facet ignores active provider filter", () => {
  const s = new Store(":memory:");
  s.record(rep([
    sess({ id: "h1:1", pid: 1, providerSessionId: "k1", provider: "claude", category: "code" }),
    sess({ id: "h1:2", pid: 2, providerSessionId: "k2", provider: "codex", category: "review" }),
  ], 1000), 1000);

  // No filter: both providers listed with counts.
  const f0 = s.facets({});
  expect(f0.providers.find((p) => p.value === "claude")!.count).toBe(1);
  expect(f0.providers.find((p) => p.value === "codex")!.count).toBe(1);

  // Filter provider=claude: providers facet STILL lists codex (self-excluding),
  // but categories facet reflects the claude-only filter.
  const f1 = s.facets({ provider: "claude" });
  expect(f1.providers.map((p) => p.value).sort()).toEqual(["claude", "codex"]);
  expect(f1.categories.map((c) => c.value)).toEqual(["code"]);
  s.close();
});
```

**Step 2: Run, verify it fails**

Run: `bun test packages/server/src/store.test.ts -t "self-excluding"`
Expected: FAIL.

**Step 3: Implement**

Add response type near the other exported types:

```ts
export type FacetBucket = { value: string; count: number; label?: string };
export type Facets = {
  providers: FacetBucket[];
  categories: FacetBucket[];
  hosts: FacetBucket[];
  states: FacetBucket[];
};
```

Refactor `sessionsWhere` to optionally drop one dimension. Change its signature to accept an `except` set, and skip that dimension's clause:

```ts
  private sessionsWhere(filter: SessionFilter, except?: string): { clause: string; params: any[] } {
    const where: string[] = [];
    const params: any[] = [];
    const add = (clause: string, value: unknown) => { where.push(clause); params.push(value); };
    if (filter.state != null && except !== "state") add("state = ?", filter.state);
    if (filter.provider != null && except !== "provider") add("provider = ?", filter.provider);
    if (filter.category != null && except !== "category") add("category = ?", filter.category);
    if (filter.cwd != null && except !== "cwd") add("cwd = ?", filter.cwd);
    if (filter.since != null) add("started_at >= ?", filter.since);
    if (filter.until != null) add("started_at <= ?", filter.until);
    // ... minTokens unchanged ...
    // ... q block unchanged (always applies) ...
  }
```

(Existing callers pass no `except` → behavior unchanged.)

Add the method:

```ts
  /** Faceted counts for filter chips. Each dimension is computed with all active
   * filters EXCEPT its own (standard self-excluding faceting), so a dropdown stays
   * navigable after you pick a value from it. */
  facets(filter: SessionFilter = {}): Facets {
    const dim = (col: string, except: string): FacetBucket[] => {
      const { clause, params } = this.sessionsWhere(filter, except);
      const rows = this.db
        .query(`SELECT ${col} AS value, COUNT(*) c FROM sessions${clause} GROUP BY ${col} ORDER BY c DESC`)
        .all(...params) as any[];
      return rows.filter((r) => r.value != null).map((r) => ({ value: String(r.value), count: r.c }));
    };
    const hosts = (() => {
      const { clause, params } = this.sessionsWhere(filter, "host");
      const rows = this.db
        .query(`SELECT host_id AS value, host_label AS label, COUNT(*) c FROM sessions${clause} GROUP BY host_id ORDER BY c DESC`)
        .all(...params) as any[];
      return rows.filter((r) => r.value != null).map((r) => ({ value: String(r.value), count: r.c, label: r.label ?? undefined }));
    })();
    return {
      providers: dim("provider", "provider"),
      categories: dim("category", "category"),
      states: dim("state", "state"),
      hosts,
    };
  }
```

> `col`/`except` are literals from this method, never user input — interpolation is safe.

**Step 4: Run, verify pass**

Run: `bun test packages/server/src/store.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/store.ts packages/server/src/store.test.ts
git commit -m "feat(store): self-excluding facets()"
```

---

## Task 8: `timeseries()` cost/token rollup (per-session delta, cross-resolution)

**Files:**
- Modify: `packages/shared/src/types.ts` (response type) and `packages/server/src/store.ts`
- Test: `packages/server/src/store.test.ts`

Samples are cumulative. Spend-per-bucket = per-session delta across consecutive samples, clamped `>= 0`, summed into buckets. Reads across resolutions: select rows for the window in **all** resolutions ordered by `(session_key, at)` — condensation leaves at most one resolution per time region per session, so the cumulative series stays monotonic; the first in-window sample per session yields a null delta → contributes 0.

**Step 1: Write the failing test**

```ts
test("timeseries: per-session delta, clamps restarts, buckets by day", () => {
  const s = new Store(":memory:", { sampleIntervalMs: 0 }); // disable sample gate
  const D = 86_400_000;
  // One session, cumulative cost 0->2->5 across 3 days, then a restart back to 1.
  const base = sess({ providerSessionId: "k1" });
  s.record(rep([{ ...base, costUsd: 0,  contextTokens: 0 }], 0), 0);
  s.record(rep([{ ...base, costUsd: 2,  contextTokens: 0 }], D), D);
  s.record(rep([{ ...base, costUsd: 5,  contextTokens: 0 }], 2 * D), 2 * D);
  s.record(rep([{ ...base, costUsd: 1,  contextTokens: 0 }], 3 * D), 3 * D); // restart: delta clamped to 0

  const ts = s.timeseries({ since: 0, until: 4 * D, bucket: "day", metric: "cost" });
  // day0: first sample -> 0; day1: 2-0=2; day2: 5-2=3; day3: max(1-5,0)=0
  const byT = Object.fromEntries(ts.series.map((p: any) => [p.t, p.value]));
  expect(byT[0]).toBe(0);
  expect(byT[D]).toBe(2);
  expect(byT[2 * D]).toBe(3);
  expect(byT[3 * D]).toBe(0);
  s.close();
});
```

> Note: pass `{ sampleIntervalMs: 0 }` so every `record` writes a raw sample (the gate at `store.ts:585` otherwise allows one per interval).

**Step 2: Run, verify it fails**

Run: `bun test packages/server/src/store.test.ts -t "per-session delta"`
Expected: FAIL.

**Step 3: Implement**

(a) Add to `packages/shared/src/types.ts`:

```ts
export type TimeseriesPoint = { t: number; value: number };
export type TimeseriesResponse = {
  bucket: "hour" | "day";
  metric: "cost" | "tokens";
  /** groupBy=none → one implicit series in `series` with key ""; else one per group. */
  series: ({ key?: string } & { points?: TimeseriesPoint[] } | TimeseriesPoint)[];
};
```

> Keep the response simple and **uniform**: always emit `{ bucket, metric, series }` where each series is `{ key: string; points: TimeseriesPoint[] }`. For `groupBy=none`, `key` is `""`. (Drop the union above; use the uniform shape below.)

Final type:

```ts
export type TimeseriesPoint = { t: number; value: number };
export type TimeseriesSeries = { key: string; points: TimeseriesPoint[] };
export type TimeseriesResponse = {
  bucket: "hour" | "day";
  metric: "cost" | "tokens";
  series: TimeseriesSeries[];
};
```

(b) Add the method to `store.ts` (import the new types). Compute deltas in SQL, bucket/group/zero-fill in TS:

```ts
  timeseries(opts: {
    since: number; until: number;
    bucket?: "hour" | "day";
    metric?: "cost" | "tokens";
    groupBy?: "none" | "category" | "provider";
    provider?: string; category?: string; host?: string;
  }): TimeseriesResponse {
    const bucket = opts.bucket ?? "day";
    const metric = opts.metric ?? "cost";
    const groupBy = opts.groupBy ?? "none";
    const bucketOf = bucket === "hour" ? hourBucket : dayBucket;
    const step = bucket === "hour" ? HOUR_MS : DAY_MS;
    const metricCol = metric === "cost"
      ? "s.cost_usd"
      : "(COALESCE(s.tokens_in,0)+COALESCE(s.tokens_out,0)+COALESCE(s.tokens_cache_read,0)+COALESCE(s.tokens_cache_write,0))";

    const where = ["s.at >= ?", "s.at <= ?"];
    const params: any[] = [opts.since, opts.until];
    if (opts.provider != null) { where.push("se.provider = ?"); params.push(opts.provider); }
    if (opts.category != null) { where.push("se.category = ?"); params.push(opts.category); }
    if (opts.host != null) { where.push("se.host_id = ?"); params.push(opts.host); }
    const groupCol = groupBy === "category" ? "se.category" : groupBy === "provider" ? "se.provider" : "''";

    const sql = `
      SELECT d.at AS at, d.grp AS grp, MAX(d.delta, 0) AS value FROM (
        SELECT s.at AS at, ${groupCol} AS grp,
          ${metricCol} - LAG(${metricCol}) OVER (PARTITION BY s.session_key ORDER BY s.at) AS delta
        FROM samples s JOIN sessions se ON se.session_key = s.session_key
        WHERE ${where.join(" AND ")}
      ) d WHERE d.delta IS NOT NULL`;
    const rows = this.db.query(sql).all(...params) as any[];

    // Bucket + sum per group, zero-fill the bucket axis.
    const buckets: number[] = [];
    for (let t = bucketOf(opts.since); t <= opts.until; t += step) buckets.push(t);
    const byGroup = new Map<string, Map<number, number>>();
    for (const r of rows) {
      const key = String(r.grp ?? "");
      const t = bucketOf(r.at);
      const m = byGroup.get(key) ?? new Map<number, number>();
      m.set(t, (m.get(t) ?? 0) + r.value);
      byGroup.set(key, m);
    }
    if (byGroup.size === 0) byGroup.set("", new Map());
    const series: TimeseriesSeries[] = [...byGroup.entries()].map(([key, m]) => ({
      key,
      points: buckets.map((t) => ({ t, value: m.get(t) ?? 0 })),
    }));
    return { bucket, metric, series };
  }
```

> `MAX(delta, 0)` is SQLite's two-arg scalar max (clamps negatives). `groupCol`/`metricCol` are internal literals, not user input.

**Step 4: Run, verify pass**

Run: `bun test packages/server/src/store.test.ts`
Expected: PASS.

Add a second test for cross-resolution fallback (seed a session with `resolution:"day"` rows via `importSession` for an old window plus `raw` rows recent; assert both windows contribute). Keep it small; commit with the main test.

**Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/server/src/store.ts packages/server/src/store.test.ts
git commit -m "feat(store): timeseries() cost/token rollup with per-session delta"
```

---

## Task 9: Wire new params + routes in the server

**Files:**
- Modify: `packages/server/src/index.ts` (`parseSessionsFilter` ~277-300; `handleReadApi` ~318-355)
- Test: `packages/server/src/index.test.ts` if present, else add focused tests via `handleReadApi` export or an integration test. (Check whether `index.ts` exports testable fns; if not, test param validation by extracting a small pure parser — see Step 3.)

**Step 1: Write the failing test**

Prefer testing the pure parsers. If `parseSessionsFilter` isn't exported, export it (and `parseQuestsFilter`, `parseTimeseriesOpts`). Add `packages/server/src/index.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseSessionsFilter, parseTimeseriesOpts } from "./index.ts";

test("parseSessionsFilter: whitelists sort, rejects junk", () => {
  expect(parseSessionsFilter(new URL("http://x/api/sessions?sort=cost&order=asc&q=hi")))
    .toMatchObject({ sort: "cost", order: "asc", q: "hi" });
  // junk sort dropped (falls back to default at query time)
  expect(parseSessionsFilter(new URL("http://x/api/sessions?sort=DROP")).sort).toBeUndefined();
});

test("parseTimeseriesOpts: defaults + enum validation", () => {
  const ok = parseTimeseriesOpts(new URL("http://x/api/stats/timeseries?since=0&until=100&bucket=hour&metric=tokens"));
  expect(ok).toMatchObject({ since: 0, until: 100, bucket: "hour", metric: "tokens" });
  // bad bucket => null (caller returns 400)
  expect(parseTimeseriesOpts(new URL("http://x/api/stats/timeseries?since=0&until=1&bucket=year"))).toBeNull();
  // missing since/until => null
  expect(parseTimeseriesOpts(new URL("http://x/api/stats/timeseries?bucket=day"))).toBeNull();
});
```

**Step 2: Run, verify it fails**

Run: `bun test packages/server/src/index.test.ts`
Expected: FAIL (functions not exported / not implemented).

**Step 3: Implement**

(a) Extend `parseSessionsFilter` (`index.ts:277`) — add `export`, and parse the new params:

```ts
  const q = strParam(url, "q");
  if (q) filter.q = q;
  const sort = strParam(url, "sort");
  if (sort && ["lastSeen", "started", "cost", "tokens", "context"].includes(sort)) filter.sort = sort as any;
  const order = strParam(url, "order");
  if (order === "asc" || order === "desc") filter.order = order;
```

(b) Add exported parsers:

```ts
export function parseQuestsFilter(url: URL) {
  const filter: Parameters<typeof store.listQuests>[0] = {};
  const status = strParam(url, "status");
  if (status && ["pending", "in_progress", "completed"].includes(status)) filter.status = status as any;
  const provider = strParam(url, "provider");
  if (provider) filter.provider = provider;
  const category = strParam(url, "category");
  if (category) filter.category = category;
  const state = strParam(url, "state");
  if (state) filter.sessionState = state as any;
  const limit = numParam(url, "limit");
  if (limit !== undefined) filter.limit = Math.min(2000, Math.max(1, Math.floor(limit)));
  return filter;
}

export function parseTimeseriesOpts(url: URL): Parameters<typeof store.timeseries>[0] | null {
  const since = numParam(url, "since");
  const until = numParam(url, "until");
  if (since === undefined || until === undefined || until < since) return null;
  const bucket = strParam(url, "bucket") ?? "day";
  if (!["hour", "day"].includes(bucket)) return null;
  const metric = strParam(url, "metric") ?? "cost";
  if (!["cost", "tokens"].includes(metric)) return null;
  const groupBy = strParam(url, "groupBy") ?? "none";
  if (!["none", "category", "provider"].includes(groupBy)) return null;
  const opts: Parameters<typeof store.timeseries>[0] = { since, until, bucket: bucket as any, metric: metric as any, groupBy: groupBy as any };
  const provider = strParam(url, "provider"); if (provider) opts.provider = provider;
  const category = strParam(url, "category"); if (category) opts.category = category;
  const host = strParam(url, "host"); if (host) opts.host = host;
  return opts;
}
```

(c) Add routes in `handleReadApi` (`index.ts:320`), before the `/api/sessions/` prefix block:

```ts
  if (pathname === "/api/facets") {
    return Response.json(store.facets(parseSessionsFilter(url)));
  }
  if (pathname === "/api/quests") {
    return Response.json(store.listQuests(parseQuestsFilter(url)));
  }
  if (pathname === "/api/stats/timeseries") {
    const opts = parseTimeseriesOpts(url);
    if (!opts) return Response.json({ error: "bad params" }, { status: 400 });
    return Response.json(store.timeseries(opts));
  }
```

(d) In the `/api/sessions/` prefix block (`index.ts:336`), add `/quests` handling alongside `/samples`:

```ts
    if (rest.endsWith("/quests")) {
      const key = decodeURIComponent(rest.slice(0, -"/quests".length));
      return Response.json(store.getQuests(key));
    }
```

> Wrap nothing extra in try/catch here — `handleReadApi`'s caller already guards the read path the same way other `/api/*` reads are guarded. Confirm by reading the call site of `handleReadApi` and match the surrounding pattern.

**Step 4: Run, verify pass**

Run: `bun test packages/server/src/index.test.ts && bunx tsc`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/index.ts packages/server/src/index.test.ts
git commit -m "feat(server): wire q/sort + /api/facets, /api/quests, /api/stats/timeseries"
```

---

## Task 10: Full suite + typecheck + manual smoke

**Step 1: Run everything**

Run: `bun test && bunx tsc`
Expected: all green, no type errors.

**Step 2: Manual smoke (optional but recommended)**

```bash
bun run dev    # server + local reporter
# in another shell:
curl 'http://localhost:<port>/api/sessions?sort=cost&order=desc&q=&limit=5' | jq '.total'
curl 'http://localhost:<port>/api/facets' | jq '.providers'
curl 'http://localhost:<port>/api/quests?status=in_progress' | jq 'length'
curl 'http://localhost:<port>/api/stats/timeseries?since=0&until='"$(date +%s000)"'&bucket=day' | jq '.series[0].points | length'
```
(Find the port in dev output / README. Use `?token=` if the read endpoints require it in this env — they're public per design, but confirm.)

**Step 3: Update docs**

Add the four new endpoints + params to `README.md` (env/endpoint table) and note `work_items` table in `CLAUDE.md`'s persistence section (one line each).

**Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document search/sort/facets/timeseries/quests endpoints + work_items"
```

---

## Done criteria

- `bun test` green (new store/parser/claude tests + existing suite).
- `bunx tsc` clean.
- `/api/sessions` honors `q`/`sort`/`order`; `/api/facets`, `/api/quests`, `/api/sessions/:key/quests`, `/api/stats/timeseries` return correct shapes.
- Live board + `/ws/live` unchanged; `workItems` ride on `Session` to the browser for free.
- No schema migration beyond additive `work_items` table (`CREATE TABLE IF NOT EXISTS`).
```
