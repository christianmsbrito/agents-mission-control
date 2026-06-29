# Spawn agents into tmux (templates / "lords" + XP) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deploy a new agent session from the Mission Control board into a tmux window on a host, driven by reusable templates ("lords") that accumulate XP across every session they spawn.

**Architecture:** Spawn is a 4th verb on the existing server→reporter reverse channel (alongside focus/kill/prompt). Templates live in a new SQLite `templates` table; a nullable `sessions.template_id` links each spawned session back to its lord. XP is derived on read (rollup query), never a stored counter. Lineage is established by launching the pane with a `MC_TEMPLATE_ID=<id>` env var that the reporter reads back off the process and stamps onto the `Session`. Lord *writes* are token-gated; spawn is bounded to pre-defined templates and built as argv (no shell interpolation).

**Tech Stack:** Bun, TypeScript (`.ts` extension imports), `bun:sqlite`, React 19, tmux CLI, `bun test`.

**Design reference:** `docs/plans/2026-06-20-tmux-agent-spawn-design.md`

**Conventions to honor (from CLAUDE.md):**
- Pure-function-first tests; side effects (tmux, ps, sockets, fs) at the edges.
- `store.*` calls only in `index.ts`, each try/catch-guarded (best-effort persistence).
- Reporter `enrich`-style code must never throw to the caller.
- Events dual-written: `events.jsonl` (via `publishEvent`) + sqlite `events` table (via `store.event`).
- Imports carry explicit `.ts`/`.tsx` extensions.

**Run all tests:** `cd .worktrees/tmux-spawn && bun test`
**Typecheck:** `bunx tsc`

---

## Task 1: Shared contract — types + template validation

**Files:**
- Create: `packages/shared/src/template.ts`
- Create: `packages/shared/src/template.test.ts`
- Modify: `packages/shared/src/types.ts` (Session ~line 66; message unions 136-178)
- Modify: `packages/shared/src/index.ts` (re-export new module — verify it barrel-exports)

**Step 1: Write failing test** `packages/shared/src/template.test.ts`

```ts
import { expect, test, describe } from "bun:test";
import { slugify, validateTemplateInput } from "./template.ts";

describe("slugify", () => {
  test("kebab-cases a name", () => {
    expect(slugify("Code Review Lord")).toBe("code-review-lord");
  });
  test("strips junk and collapses dashes", () => {
    expect(slugify("  Feature!! Lord  ")).toBe("feature-lord");
  });
});

describe("validateTemplateInput", () => {
  test("accepts a minimal valid template", () => {
    const r = validateTemplateInput({ name: "Feature Lord", provider: "claude" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe("feature-lord");
      expect(r.value.provider).toBe("claude");
      expect(r.value.args).toEqual([]);
    }
  });
  test("honors an explicit id", () => {
    const r = validateTemplateInput({ id: "cr", name: "X", provider: "codex" });
    expect(r.ok && r.value.id).toBe("cr");
  });
  test("rejects missing name", () => {
    expect(validateTemplateInput({ provider: "claude" }).ok).toBe(false);
  });
  test("rejects missing provider", () => {
    expect(validateTemplateInput({ name: "X" }).ok).toBe(false);
  });
  test("rejects non-string args entries", () => {
    expect(validateTemplateInput({ name: "X", provider: "claude", args: [1] as any }).ok).toBe(false);
  });
  test("coerces args/prompt/cwd to clean values", () => {
    const r = validateTemplateInput({ name: "X", provider: "claude", args: ["--model", "o1"], prompt: "hi", cwd: "/tmp" });
    expect(r.ok && r.value.args).toEqual(["--model", "o1"]);
    expect(r.ok && r.value.prompt).toBe("hi");
    expect(r.ok && r.value.cwd).toBe("/tmp");
  });
});
```

**Step 2: Run, expect FAIL** — `bun test packages/shared/src/template.test.ts` → "Cannot find module ./template.ts"

**Step 3: Implement** `packages/shared/src/template.ts`

```ts
/** A spawn template ("lord"): a reusable recipe for deploying an agent session. */
export type Template = {
  id: string;
  name: string;
  provider: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  /** Free-form RPG card metadata (class/sprite/color). */
  rpg?: Record<string, unknown>;
  createdAt: number;
  archivedAt?: number;
};

/** A lord plus its derived XP rollup (computed on read, never stored). */
export type LordWithXp = Template & {
  troopsDeployed: number;
  totalCost: number;
  totalTokens: number;
  lastDeploy: number | null;
  level: number;
};

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type TemplateInput = {
  id?: string;
  name?: unknown;
  provider?: unknown;
  args?: unknown;
  prompt?: unknown;
  cwd?: unknown;
  rpg?: unknown;
};

export type ValidationResult =
  | { ok: true; value: Omit<Template, "createdAt" | "archivedAt"> }
  | { ok: false; error: string };

/** Validate + normalize raw template input from the API. Pure. */
export function validateTemplateInput(raw: TemplateInput): ValidationResult {
  if (typeof raw.name !== "string" || !raw.name.trim()) return { ok: false, error: "name required" };
  if (typeof raw.provider !== "string" || !raw.provider.trim()) return { ok: false, error: "provider required" };
  let args: string[] = [];
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string"))
      return { ok: false, error: "args must be string[]" };
    args = raw.args as string[];
  }
  if (raw.prompt !== undefined && typeof raw.prompt !== "string") return { ok: false, error: "prompt must be string" };
  if (raw.cwd !== undefined && raw.cwd !== null && typeof raw.cwd !== "string")
    return { ok: false, error: "cwd must be string" };
  const id = (typeof raw.id === "string" && raw.id.trim() ? slugify(raw.id) : slugify(raw.name));
  if (!id) return { ok: false, error: "could not derive id" };
  const value: Omit<Template, "createdAt" | "archivedAt"> = {
    id,
    name: raw.name.trim(),
    provider: raw.provider.trim(),
    args,
  };
  if (typeof raw.prompt === "string" && raw.prompt) value.prompt = raw.prompt;
  if (typeof raw.cwd === "string" && raw.cwd) value.cwd = raw.cwd;
  if (raw.rpg && typeof raw.rpg === "object") value.rpg = raw.rpg as Record<string, unknown>;
  return { ok: true, value };
}

/** XP → level. Derived; simple log-ish curve over troops + tokens. Pure. */
export function lordLevel(troopsDeployed: number, totalTokens: number): number {
  const xp = troopsDeployed * 100 + Math.floor(totalTokens / 10_000);
  return Math.max(1, Math.floor(Math.sqrt(xp / 25)) + 1);
}
```

**Step 4: Run, expect PASS** — `bun test packages/shared/src/template.test.ts`

**Step 5: Edit `packages/shared/src/types.ts`** — add `templateId?: string;` to `Session` (after `workItems?` ~line 66), and the wire messages:

```ts
// add to ReporterMsg union (line 138) — reporter → server spawn ack
export type SpawnedMsg = {
  type: "spawned"; ok: boolean; templateId: string;
  hostId?: string; windowId?: string; paneId?: string; pid?: number; error?: string; commandId?: string;
};
// → ReporterMsg = ... | SpawnedMsg

// add to ServerToReporterMsg union (line 145) — server → reporter
export type SpawnMsg = {
  type: "spawn"; commandId: string; templateId: string;
  cmd: string; args: string[]; prompt?: string; cwd?: string | null; windowId?: string; name?: string;
};
// → ServerToReporterMsg = ... | SpawnMsg

// add to WebToServerMsg union (line 152) — browser → server
export type SpawnRequest = {
  type: "spawn"; hostId: string; templateId: string;
  windowId?: string; cwd?: string; promptOverride?: string;
};
// → WebToServerMsg = ... | SpawnRequest

// add to SessionEvent union (line 171)
export type SessionSpawnedEvent = BaseEvent & { type: "session.spawned"; templateId: string; windowId?: string; paneId?: string };
// → SessionEvent = ... | SessionSpawnedEvent
```

**Step 6: Verify barrel export** — confirm `packages/shared/src/index.ts` exports `./template.ts` (add `export * from "./template.ts";` if it uses explicit re-exports).

**Step 7: Typecheck** — `bunx tsc` → no errors.

**Step 8: Commit**

```bash
git add packages/shared/src/template.ts packages/shared/src/template.test.ts packages/shared/src/types.ts packages/shared/src/index.ts
git commit -m "feat(shared): template/lord types + spawn wire messages + validation"
```

---

## Task 2: Store — templates table, CRUD, lineage column, XP rollup

**Files:**
- Modify: `packages/server/src/store.ts` (migrate 349-390; upsertSession 261-302; record 566-698; new methods near getQuests ~922)
- Modify: `packages/server/src/store.test.ts`

**Step 1: Write failing test** — append to `packages/server/src/store.test.ts`

```ts
import { Store } from "./store.ts";
// (reuse existing test helpers; if a makeReport(...) helper exists, use it)

test("templates: create, list, get, archive", () => {
  const s = new Store(":memory:");
  s.createTemplate({ id: "code-review", name: "Code Review Lord", provider: "codex", args: ["--model", "o1"], createdAt: 1000 });
  const all = s.listLords();
  expect(all.length).toBe(1);
  expect(all[0]!.id).toBe("code-review");
  expect(all[0]!.troopsDeployed).toBe(0);
  expect(all[0]!.level).toBe(1);
  s.archiveTemplate("code-review", 2000);
  expect(s.listLords().length).toBe(0);            // archived excluded by default
  expect(s.getLord("code-review")?.archivedAt).toBe(2000); // still fetchable by id
  s.close();
});

test("templates: XP rolls up from sessions tagged with template_id", () => {
  const s = new Store(":memory:");
  s.createTemplate({ id: "feat", name: "Feature Lord", provider: "claude", args: [], createdAt: 1000 });
  // two sessions tagged to this lord, via a report whose sessions carry templateId
  const report = {
    hostId: "h1", hostLabel: "host", sentAt: 5000,
    sessions: [
      { id: "h1:11", provider: "claude", pid: 11, hostId: "h1", hostLabel: "host", cwd: "/a", category: "code", startedAt: 4000, cpu: 0, memMb: 0, tokensIn: 20000, tokensOut: 0, costUsd: 1, templateId: "feat" },
      { id: "h1:12", provider: "claude", pid: 12, hostId: "h1", hostLabel: "host", cwd: "/b", category: "code", startedAt: 4000, cpu: 0, memMb: 0, tokensIn: 0, tokensOut: 0, costUsd: 2, templateId: "feat" },
    ],
  } as any;
  s.record(report, 5000);
  const lord = s.getLord("feat")!;
  expect(lord.troopsDeployed).toBe(2);
  expect(lord.totalCost).toBe(3);
  expect(lord.totalTokens).toBe(20000);
  expect(lord.level).toBeGreaterThanOrEqual(1);
  s.close();
});
```

**Step 2: Run, expect FAIL** — `bun test packages/server/src/store.test.ts -t templates`

**Step 3: Implement in `store.ts`:**

(a) In `migrate()` (after work_items, ~line 385) add:

```sql
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL,
  args_json TEXT, prompt TEXT, cwd TEXT, rpg_json TEXT,
  created_at INTEGER NOT NULL, archived_at INTEGER
);
```

And after the existing guarded ALTER loop (line 388-390) add `template_id` to the column-add list so old DBs gain it:

```ts
for (const col of ["summary TEXT", "attention INTEGER", "ask TEXT", "suggestion TEXT", "template_id TEXT"]) {
  try { this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch { /* already present */ }
}
```

Also add `template_id` to the `sessions` CREATE TABLE (line 359, before closing `)`), so fresh DBs have it: `..., suggestion TEXT, template_id TEXT`.

(b) Thread `template_id` through `upsertSession` (261-302): add `template_id` to the column list + `$template_id` to VALUES, and `template_id = excluded.template_id` to the ON CONFLICT SET clause.

(c) In `record()` (566-698) where the upsert `.run({...})` binds session fields, add `$template_id: s.templateId ?? null`. (Find the existing `.run({ $session_key: ... })` for `upsertSession`.)

(d) New methods (place near `getQuests`/`listQuests`, ~line 922):

```ts
createTemplate(t: { id: string; name: string; provider: string; args: string[]; prompt?: string; cwd?: string; rpg?: Record<string, unknown>; createdAt: number }): void {
  this.db.query(
    `INSERT INTO templates (id, name, provider, args_json, prompt, cwd, rpg_json, created_at, archived_at)
     VALUES ($id,$name,$provider,$args,$prompt,$cwd,$rpg,$created,NULL)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider=excluded.provider,
       args_json=excluded.args_json, prompt=excluded.prompt, cwd=excluded.cwd,
       rpg_json=excluded.rpg_json, archived_at=NULL`,
  ).run({
    $id: t.id, $name: t.name, $provider: t.provider,
    $args: JSON.stringify(t.args ?? []), $prompt: t.prompt ?? null,
    $cwd: t.cwd ?? null, $rpg: t.rpg ? JSON.stringify(t.rpg) : null, $created: t.createdAt,
  });
}

updateTemplate(id: string, patch: Partial<{ name: string; provider: string; args: string[]; prompt: string; cwd: string; rpg: Record<string, unknown> }>): boolean {
  const cur = this.getTemplateRow(id);
  if (!cur) return false;
  this.createTemplate({
    id, createdAt: cur.created_at,
    name: patch.name ?? cur.name, provider: patch.provider ?? cur.provider,
    args: patch.args ?? JSON.parse(cur.args_json ?? "[]"),
    prompt: patch.prompt ?? cur.prompt ?? undefined,
    cwd: patch.cwd ?? cur.cwd ?? undefined,
    rpg: patch.rpg ?? (cur.rpg_json ? JSON.parse(cur.rpg_json) : undefined),
  });
  return true;
}

archiveTemplate(id: string, now: number): boolean {
  const r = this.db.query("UPDATE templates SET archived_at = ? WHERE id = ? AND archived_at IS NULL").run(now, id);
  return r.changes > 0;
}

private getTemplateRow(id: string): any {
  return this.db.query("SELECT * FROM templates WHERE id = ?").get(id);
}

getLord(id: string): LordWithXp | null {
  const row = this.getTemplateRow(id);
  return row ? this.rowToLord(row) : null;
}

/** Active (non-archived) lords with derived XP. */
listLords(): LordWithXp[] {
  const rows = this.db.query("SELECT * FROM templates WHERE archived_at IS NULL ORDER BY created_at").all() as any[];
  return rows.map((r) => this.rowToLord(r));
}

private rowToLord(r: any): LordWithXp {
  const x = this.db.query(
    `SELECT COUNT(*) AS troops, COALESCE(SUM(cost_usd),0) AS cost,
            COALESCE(SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)),0) AS tokens,
            MAX(last_seen_at) AS last
     FROM sessions WHERE template_id = ?`,
  ).get(r.id) as any;
  return {
    id: r.id, name: r.name, provider: r.provider,
    args: JSON.parse(r.args_json ?? "[]"),
    prompt: r.prompt ?? undefined, cwd: r.cwd ?? undefined,
    rpg: r.rpg_json ? JSON.parse(r.rpg_json) : undefined,
    createdAt: r.created_at, archivedAt: r.archived_at ?? undefined,
    troopsDeployed: x.troops, totalCost: x.cost, totalTokens: x.tokens,
    lastDeploy: x.last ?? null, level: lordLevel(x.troops, x.tokens),
  };
}
```

Add imports at top of `store.ts`: `import { lordLevel, type LordWithXp } from "@mc/shared";` (or `../../shared/...` matching existing import style — check the existing `@mc/shared` import line).

**Step 4: Run, expect PASS** — `bun test packages/server/src/store.test.ts`

**Step 5: Full suite** — `bun test` (ensure nothing regressed; the sessions column list change is the risk).

**Step 6: Commit**

```bash
git add packages/server/src/store.ts packages/server/src/store.test.ts
git commit -m "feat(store): templates table, CRUD, template_id lineage, derived lord XP"
```

---

## Task 3: Reporter — tmux argv builders + spawn executor

**Files:**
- Create: `packages/reporter/src/tmux.ts`
- Create: `packages/reporter/src/tmux.test.ts`

**Step 1: Write failing test** `packages/reporter/src/tmux.test.ts`

```ts
import { expect, test, describe } from "bun:test";
import { newWindowArgs, splitWindowArgs, launchKeysArgs, sessionTargetArgs } from "./tmux.ts";

describe("tmux argv builders", () => {
  test("new-window targets session, names window, sets cwd, prints ids", () => {
    expect(newWindowArgs("mc", "feature-lord", "/repo")).toEqual([
      "new-window", "-t", "mc", "-n", "feature-lord", "-c", "/repo",
      "-P", "-F", "#{window_id} #{pane_id}",
    ]);
  });
  test("split-window targets an existing window id", () => {
    expect(splitWindowArgs("@4", "/repo")).toEqual([
      "split-window", "-t", "@4", "-c", "/repo",
      "-P", "-F", "#{window_id} #{pane_id}",
    ]);
  });
  test("launch keys send the command literally then Enter", () => {
    const argv = launchKeysArgs("%7", "MC_TEMPLATE_ID=feat claude --model o1");
    expect(argv).toEqual(["send-keys", "-t", "%7", "-l", "MC_TEMPLATE_ID=feat claude --model o1"]);
  });
});
```

**Step 2: Run, expect FAIL** — `bun test packages/reporter/src/tmux.test.ts`

**Step 3: Implement** `packages/reporter/src/tmux.ts`

```ts
/** Pure argv builders for tmux (no shell string interpolation). */
const PRINT = ["-P", "-F", "#{window_id} #{pane_id}"] as const;

export function newWindowArgs(session: string, name: string, cwd?: string | null): string[] {
  const a = ["new-window", "-t", session, "-n", name];
  if (cwd) a.push("-c", cwd);
  return [...a, ...PRINT];
}
export function splitWindowArgs(windowId: string, cwd?: string | null): string[] {
  const a = ["split-window", "-t", windowId];
  if (cwd) a.push("-c", cwd);
  return [...a, ...PRINT];
}
/** send-keys with -l writes the string LITERALLY (no key-name interpretation). */
export function launchKeysArgs(paneId: string, line: string): string[] {
  return ["send-keys", "-t", paneId, "-l", line];
}
export function enterKeysArgs(paneId: string): string[] {
  return ["send-keys", "-t", paneId, "Enter"];
}
export function sessionTargetArgs(): string[] {
  return ["display-message", "-p", "#S"];
}

/** Shell-quote a single argv token for the launch line we type into the pane. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export type SpawnPlan = { cmd: string; args: string[]; prompt?: string; cwd?: string | null; templateId: string; name: string; windowId?: string };
export type SpawnResult = { ok: boolean; windowId?: string; paneId?: string; error?: string };

async function tmux(args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    return { ok: p.exitCode === 0, out };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Resolve the current/most-recent tmux session; create one if none exist. */
export async function resolveSession(): Promise<string | null> {
  const ls = await tmux(["list-sessions", "-F", "#{session_name}"]);
  if (ls.ok && ls.out) return ls.out.split("\n")[0]!; // most-recent first
  const created = await tmux(["new-session", "-d", "-P", "-F", "#{session_name}"]);
  return created.ok ? created.out.trim() : null;
}

/** Execute a spawn plan. Returns ids or an error; never throws. */
export async function spawn(plan: SpawnPlan): Promise<SpawnResult> {
  const session = await resolveSession();
  if (!session) return { ok: false, error: "no tmux session" };
  const create = plan.windowId
    ? await tmux(splitWindowArgs(plan.windowId, plan.cwd))
    : await tmux(newWindowArgs(session, plan.name, plan.cwd));
  if (!create.ok) return { ok: false, error: "tmux create failed" };
  const [windowId, paneId] = create.out.split(/\s+/);
  if (!paneId) return { ok: false, error: "no pane id" };
  const argLine = [plan.cmd, ...plan.args].map(shellQuote).join(" ");
  const line = `MC_TEMPLATE_ID=${shellQuote(plan.templateId)} ${argLine}`;
  await tmux(launchKeysArgs(paneId, line));
  await tmux(enterKeysArgs(paneId));
  if (plan.prompt) {
    await tmux(launchKeysArgs(paneId, plan.prompt));
    await tmux(enterKeysArgs(paneId));
  }
  return { ok: true, windowId, paneId };
}
```

**Step 4: Run, expect PASS** — `bun test packages/reporter/src/tmux.test.ts`

**Step 5: Commit**

```bash
git add packages/reporter/src/tmux.ts packages/reporter/src/tmux.test.ts
git commit -m "feat(reporter): tmux argv builders + spawn executor"
```

---

## Task 4: Reporter — lineage (read MC_TEMPLATE_ID off the process)

**Files:**
- Modify: `packages/reporter/src/procscan.ts` (add pure env parser + reader)
- Modify: `packages/reporter/src/procscan.test.ts`
- Modify: `packages/reporter/src/collect.ts` (set `session.templateId`)

**Step 1: Write failing test** — append to `packages/reporter/src/procscan.test.ts`

```ts
import { parseTemplateIdFromEnv } from "./procscan.ts";

test("parseTemplateIdFromEnv reads MC_TEMPLATE_ID from `ps eww` style (space-separated)", () => {
  expect(parseTemplateIdFromEnv("PID TT  STAT  TIME COMMAND\n123 s001 S 0:01 claude PATH=/usr/bin MC_TEMPLATE_ID=feat TERM=xterm")).toBe("feat");
});
test("parseTemplateIdFromEnv reads NUL-separated /proc environ", () => {
  expect(parseTemplateIdFromEnv("PATH=/usr/bin MC_TEMPLATE_ID=code-review TERM=xterm")).toBe("code-review");
});
test("parseTemplateIdFromEnv returns null when absent", () => {
  expect(parseTemplateIdFromEnv("PATH=/usr/bin TERM=xterm")).toBeNull();
});
```

**Step 2: Run, expect FAIL** — `bun test packages/reporter/src/procscan.test.ts -t parseTemplateId`

**Step 3: Implement in `procscan.ts`:**

```ts
/** Extract MC_TEMPLATE_ID from a process env blob (space- or NUL-separated). Pure. */
export function parseTemplateIdFromEnv(blob: string): string | null {
  const m = blob.match(/MC_TEMPLATE_ID=([^\s ]+)/);
  return m ? m[1]! : null;
}

/** Best-effort read of a pid's MC_TEMPLATE_ID. Never throws. */
export async function templateIdOf(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const txt = await Bun.file(`/proc/${pid}/environ`).text();
      return parseTemplateIdFromEnv(txt);
    }
    const p = Bun.spawn(["ps", "eww", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return parseTemplateIdFromEnv(out);
  } catch {
    return null;
  }
}
```

**Step 4: Run, expect PASS** — `bun test packages/reporter/src/procscan.test.ts`

**Step 5: Wire into `collect.ts`** — add `templateIdOf` to imports from `./procscan.ts`, add it to the `Deps` type (so tests can stub), default to the real one, and after building `session` (~line 57) set it best-effort:

```ts
// Deps: add  templateId?: (pid: number) => Promise<string | null>;
// defaultDeps: add  templateId: templateIdOf,
const tid = deps.templateId ? await deps.templateId(p.pid) : null;
if (tid) session.templateId = tid;
```

**Step 6: Run full suite** — `bun test` (collect.test.ts must still pass; the new dep is optional).

**Step 7: Commit**

```bash
git add packages/reporter/src/procscan.ts packages/reporter/src/procscan.test.ts packages/reporter/src/collect.ts
git commit -m "feat(reporter): MC_TEMPLATE_ID lineage tagging on spawned sessions"
```

---

## Task 5: Reporter — handle the `spawn` message

**Files:**
- Modify: `packages/reporter/src/index.ts` (imports line 1-7; message handler 50-79)

**Step 1: Implement** — import the executor and handle the new verb:

```ts
import { spawn as tmuxSpawn } from "./tmux.ts";
```

Add an `else if` branch in `ws.onmessage` (after the `prompt` branch, before `config`):

```ts
} else if (msg.type === "spawn") {
  void tmuxSpawn({
    cmd: msg.cmd, args: msg.args, prompt: msg.prompt, cwd: msg.cwd,
    templateId: msg.templateId, name: msg.name ?? msg.templateId, windowId: msg.windowId,
  }).then((r) => {
    console.log(`[reporter] spawn template=${msg.templateId} -> ${r.ok ? `${r.windowId}/${r.paneId}` : "FAILED:" + r.error}`);
    send({ type: "spawned", ok: r.ok, templateId: msg.templateId, hostId: cfg.hostId,
           windowId: r.windowId, paneId: r.paneId, error: r.error, commandId: msg.commandId });
  });
}
```

**Step 2: Typecheck** — `bunx tsc` (the `ServerToReporterMsg` union now includes `SpawnMsg`, so the narrowing compiles).

**Step 3: Commit**

```bash
git add packages/reporter/src/index.ts
git commit -m "feat(reporter): execute spawn command + ack with window/pane ids"
```

---

## Task 6: Server — route spawn request → reporter, ack → event

**Files:**
- Modify: `packages/server/src/index.ts` (live `message` handler ~597-617; reporter-ack handlers ~647+; a small `commandId`/pending map like `pendingKills`)

**Step 1: Implement live → reporter routing** — in the `/ws/live` message handler, after the existing `focus|kill|prompt` block, add:

```ts
if (m.type === "spawn") {
  const reporter = reporters.get(m.hostId);
  if (!reporter) return;
  let lord; try { lord = store.getLord(m.templateId); } catch { lord = null; }
  if (!lord || lord.archivedAt) return;            // template is the guard
  const id = commandId("spawn");
  const args = [...lord.args];
  const prompt = m.promptOverride ?? lord.prompt;
  const cwd = m.cwd ?? lord.cwd ?? null;
  reporter.send(JSON.stringify({
    type: "spawn", commandId: id, templateId: lord.id,
    cmd: lord.provider, args, prompt, cwd, windowId: m.windowId, name: lord.name,
  } satisfies SpawnMsg));
  return;
}
```

> NOTE: `cmd: lord.provider` assumes the provider id is the launch binary (claude/codex). If a provider's binary differs, add a `provider → binary` map here; for v1 the ids match the CLIs. Document this assumption.

**Step 2: Handle the `spawned` ack** — in the reporter-message section (near the `killed`/`prompted` handlers ~647), add:

```ts
else if (msg.type === "spawned" && ws.data.hostId) {
  const hostId = ws.data.hostId;
  void publishEvent({
    type: "session.spawned", at: Date.now(), sessionId: msg.paneId ? `${hostId}:pane:${msg.paneId}` : `${hostId}:spawn`,
    hostId, pid: msg.pid ?? 0, ok: msg.ok, templateId: msg.templateId,
    windowId: msg.windowId, paneId: msg.paneId, subject: msg.error,
  });
  try {
    store.event({ type: "session.spawned", at: Date.now(), sessionKey: `template:${msg.templateId}`,
      hostId, pid: msg.pid ?? null, detail: { ok: msg.ok, windowId: msg.windowId, paneId: msg.paneId, error: msg.error } as any });
  } catch { /* best-effort */ }
}
```

> Confirm `publishEvent` accepts the new `SessionSpawnedEvent` (Task 1 added it to the `SessionEvent` union). Confirm `PersistedEventType` includes `"session.spawned"` — add it in `store.ts` if that type is a closed union (grep `PersistedEventType`).

**Step 3: Import `SpawnMsg`** — ensure the `@mc/shared` import in `index.ts` includes `SpawnMsg` (and `WebToServerMsg` already covers `SpawnRequest`).

**Step 4: Typecheck + test** — `bunx tsc` && `bun test packages/server`.

**Step 5: Commit**

```bash
git add packages/server/src/index.ts packages/server/src/store.ts
git commit -m "feat(server): route spawn request to reporter, dual-write session.spawned"
```

---

## Task 7: Server — lord HTTP API (read public, writes token-gated)

**Files:**
- Modify: `packages/server/src/index.ts` (`handleReadApi` ~364; `handleApi` ~416)
- Modify: `packages/server/src/server.test.ts`

**Step 1: Write failing test** — append to `packages/server/src/server.test.ts` (follow the existing fetch-against-server pattern; reuse its base URL + TOKEN helpers):

```ts
test("POST /api/lords requires token; GET /api/lords is public", async () => {
  const base = /* existing test server base url */;
  // unauth POST → 401
  const bad = await fetch(`${base}/api/lords`, { method: "POST", body: JSON.stringify({ name: "X", provider: "claude" }) });
  expect(bad.status).toBe(401);
  // auth POST → 200 + created
  const ok = await fetch(`${base}/api/lords`, { method: "POST", headers: { "x-mc-token": TOKEN }, body: JSON.stringify({ name: "Code Review", provider: "codex" }) });
  expect(ok.status).toBe(200);
  // public GET lists it
  const list = await (await fetch(`${base}/api/lords`)).json();
  expect(list.some((l: any) => l.id === "code-review")).toBe(true);
});
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement GET in `handleReadApi`** (public), after the `/api/quests` case:

```ts
if (pathname === "/api/lords") return Response.json(store.listLords());
if (pathname.startsWith("/api/lords/")) {
  const id = decodeURIComponent(pathname.slice("/api/lords/".length));
  const lord = store.getLord(id);
  return lord ? Response.json(lord) : Response.json({ error: "not found" }, { status: 404 });
}
```

**Step 4: Implement writes in `handleApi`** (already token-gated by `apiAuthed` at line 417), add cases:

```ts
if (url.pathname === "/api/lords" && req.method === "POST") {
  const body = await readJson(req);
  const v = validateTemplateInput(body ?? {});
  if (!v.ok) return json({ ok: false, error: v.error }, 400);
  try { store.createTemplate({ ...v.value, createdAt: Date.now() }); } catch (e) { return json({ ok: false, error: String(e) }, 500); }
  return json(store.getLord(v.value.id));
}
if (url.pathname.startsWith("/api/lords/") && (req.method === "PATCH" || req.method === "DELETE")) {
  const id = decodeURIComponent(url.pathname.slice("/api/lords/".length));
  if (req.method === "DELETE") return json({ ok: store.archiveTemplate(id, Date.now()) });
  const body = await readJson(req);
  const v = validateTemplateInput({ ...body, id, name: body?.name ?? "x", provider: body?.provider ?? "x" });
  // PATCH is partial: only pass provided fields to updateTemplate
  const patch: any = {};
  for (const k of ["name", "provider", "args", "prompt", "cwd", "rpg"]) if (body?.[k] !== undefined) patch[k] = body[k];
  return json({ ok: store.updateTemplate(id, patch) });
}
```

Add `validateTemplateInput` to the `@mc/shared` import in `index.ts`.

**Step 5: Run, expect PASS** — `bun test packages/server/src/server.test.ts`. Full suite: `bun test`.

**Step 6: Commit**

```bash
git add packages/server/src/index.ts packages/server/src/server.test.ts
git commit -m "feat(server): lord HTTP API — public reads, token-gated writes"
```

---

## Task 8: Web — lords roster, deploy form, lord editor

**Files:**
- Modify: `packages/web/src/useLive.ts` (add a `spawn(req)` sender over the live WS)
- Create: `packages/web/src/LordsBar.tsx`
- Modify: `packages/web/src/App.tsx` (render `<LordsBar/>`)
- Modify: `packages/web/src/prefs.ts` + `prefs.test.ts` (store MC token client-side)
- Modify: `packages/web/src/rpg.ts` (reuse `lordLevel`/XP→class mapping if desired)

**Step 1: prefs token (TDD)** — add a test in `prefs.test.ts` for get/set of an `apiToken` pref; implement in `prefs.ts` mirroring existing pref accessors. Run → PASS.

**Step 2: useLive spawn sender** — expose `spawn(req: SpawnRequest)` that sends `JSON.stringify({ type: "spawn", ...req })` over the live socket (mirror how focus/kill/prompt are already sent from the client — grep `"kill"` in web).

**Step 3: LordsBar.tsx** — fetch `GET /api/lords` (poll or on mount), render each lord as a card (reuse `CharacterCard` styling / `rpg.ts`): name, provider badge, level, XP/troops/cost. Each card has a **Deploy** button → small form (host select — auto when one host from `useLive` hosts; cwd prefilled from lord.cwd; "new window" vs existing window dropdown; optional prompt override) → calls `spawn(...)`. A **＋ New Lord** button + edit pencil open a form that POST/PATCHes `/api/lords` with the `x-mc-token` header from prefs.

**Step 4: App.tsx** — mount `<LordsBar hosts={hosts} spawn={spawn} />` in the board chrome (near the party board header). Match the existing Final Fantasy theme (see `mission-control-theming` skill + `styles.css`).

> Use the `frontend-design` skill for the card/form visuals. Keep logic minimal; the board already updates within a tick once the troop appears tagged to its lord.

**Step 5: Build web** — `bun run build:web` must succeed. `bun test` (web format/prefs/rpg tests pass).

**Step 6: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): lords roster + deploy form + lord editor"
```

---

## Task 9: Docs + manual verification

**Files:**
- Modify: `README.md` (provider/binary assumption for spawn; note tmux required on host; `session.spawned` event; lord API endpoints)
- Modify: `CLAUDE.md` (persistence section: add `templates` table + `sessions.template_id`; note spawn as 4th reverse-channel verb)
- Modify: `docs/plans/2026-06-20-tmux-agent-spawn-design.md` (Status → implemented)

**Step 1: Manual end-to-end** (requires tmux + a real reporter; `bun run dev`):
1. Create a lord: `curl -XPOST localhost:PORT/api/lords -H x-mc-token:TOKEN -d '{"name":"Feature Lord","provider":"claude","cwd":"/some/repo"}'`
2. From the web board, click Deploy on the lord.
3. `tmux list-windows` on the host shows a new window; the agent launches; within a tick the board shows the new session tagged to the lord; `GET /api/lords` shows `troopsDeployed: 1`.
4. Spawn a second troop into the same window via the "existing window" option → confirm a split pane.

**Step 2: Full suite + typecheck** — `bun test` (all green) && `bunx tsc` (clean).

**Step 3: Commit**

```bash
git add README.md CLAUDE.md docs/plans/2026-06-20-tmux-agent-spawn-design.md
git commit -m "docs: tmux spawn / lords feature + mark design implemented"
```

---

## Done criteria
- `bun test` all green; `bunx tsc` clean.
- A lord created via token-gated API; deploy from the board opens a tmux window running the agent; the spawned session is tagged back to its lord and XP increments.
- Reads (`GET /api/lords`) public; writes 401 without token.
- No `store.*` call outside `index.ts`; all guarded. Reporter spawn path never throws to the caller.
