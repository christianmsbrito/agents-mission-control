import { expect, test, describe } from "bun:test";
import { join } from "node:path";
import { parsePs, parseEtime, parseLsof } from "./procscan.ts";
import { extractClis } from "./clis.ts";
import { killPid } from "./kill.ts";
import { matchProvider } from "./providers/index.ts";
import { parseClaudeTranscript, encodeProjectDir, claudePlugin, statusOnly } from "./providers/claude.ts";
import { parseCodexRollout, codexPlugin } from "./providers/codex.ts";
import { assembleOpencode } from "./providers/opencode.ts";
import { assembleHermes } from "./providers/hermes.ts";
import { openclawPlugin } from "./providers/openclaw.ts";
import { parsePiSession } from "./providers/pi.ts";
import { collect } from "./collect.ts";
import type { ReporterConfig } from "./config.ts";

const FIX = join(import.meta.dir, "..", "fixtures");
// Separate home whose sessions/999.json is status:busy and whose transcript ends
// in an API error — used to verify the active guard clears a stale crashed status.
const ERR_FIX = join(import.meta.dir, "..", "fixtures", "err-home");

describe("procscan", () => {
  test("parseEtime handles all formats", () => {
    expect(parseEtime("05")).toBe(5);
    expect(parseEtime("02:03")).toBe(123);
    expect(parseEtime("01:02:03")).toBe(3723);
    expect(parseEtime("2-01:00:00")).toBe(2 * 86400 + 3600);
  });

  test("parsePs extracts rows incl. spaced args", () => {
    const out = [
      "  501  1  01:00  3.5  524288  ttys001  claude  node /usr/bin/claude --foo bar",
      "  777  1  10  0.0  10240  ??  bash  -bash",
    ].join("\n");
    const rows = parsePs(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pid: 501, cpu: 3.5, memMb: 512, comm: "claude", tty: "ttys001" });
    expect(rows[0]!.args).toContain("--foo bar");
    expect(rows[0]!.uptimeSec).toBe(60);
    expect(rows[1]!.tty).toBeUndefined(); // "??" => no controlling tty
  });

  test("parseLsof extracts cwd and open regular files", () => {
    const out = [
      "p501",
      "fcwd",
      "tDIR",
      "n/Users/me/proj",
      "f3",
      "tREG",
      "n/Users/me/.codex/sessions/2026/06/16/rollout-abc.jsonl",
      "f4",
      "tREG",
      "n/Users/me/notes.txt",
      "f5",
      "tCHR",
      "n/dev/null",
    ].join("\n");
    const r = parseLsof(out);
    expect(r.cwd).toBe("/Users/me/proj");
    expect(r.openFiles).toEqual([
      "/Users/me/.codex/sessions/2026/06/16/rollout-abc.jsonl",
      "/Users/me/notes.txt",
    ]);
  });
});

describe("killPid", () => {
  test("refuses unknown pids; kills a known one", async () => {
    const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const pid = proc.pid;
    expect(killPid(pid, new Set())).toBe(false); // not a tracked agent → refuse
    expect(killPid(1, new Set([1]))).toBe(false); // never kill pid<=1
    expect(killPid(pid, new Set([pid]))).toBe(true); // tracked → SIGTERM
    await proc.exited; // confirms it actually terminated
  });
});

describe("extractClis", () => {
  test("pulls notable CLIs, drops builtins/coreutils, handles pipes/env/sudo", () => {
    expect(extractClis("git status")).toEqual(["git"]);
    expect(extractClis("git diff | grep foo | wc -l")).toEqual(["git"]); // grep/wc filtered
    expect(extractClis("cd /repo && npm run build && gh pr create")).toEqual(["npm", "gh"]);
    expect(extractClis("FOO=bar sudo kubectl get pods")).toEqual(["kubectl"]);
    expect(extractClis("/usr/local/bin/docker ps")).toEqual(["docker"]); // path stripped
    expect(extractClis("ls -la")).toEqual([]); // pure coreutils => nothing
  });
});

describe("provider matching", () => {
  const base = { pid: 1, ppid: 0, uptimeSec: 0, cpu: 0, memMb: 0 };
  test("matches each provider by args/comm", () => {
    expect(matchProvider({ ...base, comm: "claude", args: "node /x/claude" })?.id).toBe("claude");
    expect(matchProvider({ ...base, comm: "node", args: "codex chat" })?.id).toBe("codex");
    expect(matchProvider({ ...base, comm: "hermes", args: "hermes" })?.id).toBe("hermes");
    expect(matchProvider({ ...base, comm: "bash", args: "-bash" })).toBeUndefined();
  });
});

describe("claude enrichment", () => {
  test("encodeProjectDir", () => {
    expect(encodeProjectDir("/tmp/proj")).toBe("-tmp-proj");
  });

  test("parseClaudeTranscript sums tokens, tools, model, summary", () => {
    const e = parseClaudeTranscript(
      `{"type":"summary","summary":"hi"}\n` +
        `{"message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"cache_read_input_tokens":50,"output_tokens":20},"content":[{"type":"tool_use","name":"Read"}]}}`,
    );
    expect(e.tokensIn).toBe(100);
    expect(e.tokensCacheRead).toBe(50);
    expect(e.tokensOut).toBe(20);
    expect(e.model).toBe("claude-opus-4-8");
    expect(e.summary).toBe("hi");
    expect(e.toolsUsed).toEqual(["Read"]);
  });

  test("cache_creation goes to tokensCacheWrite, not tokensIn", () => {
    const e = parseClaudeTranscript(
      `{"message":{"usage":{"input_tokens":100,"cache_creation_input_tokens":2000,"cache_read_input_tokens":50,"output_tokens":20}}}`,
    );
    expect(e.tokensIn).toBe(100); // fresh input only
    expect(e.tokensCacheWrite).toBe(2000);
    expect(e.tokensCacheRead).toBe(50);
  });

  test("contextTokens = last turn occupancy, not the cumulative sum", () => {
    // Two turns; the running sums grow but context occupancy is the LAST turn's
    // full prompt (fresh + cache read + cache write) + that turn's output.
    const e = parseClaudeTranscript(
      `{"message":{"id":"a","usage":{"input_tokens":100,"cache_read_input_tokens":50,"output_tokens":20}}}\n` +
        `{"message":{"id":"b","usage":{"input_tokens":200,"cache_read_input_tokens":4000,"cache_creation_input_tokens":300,"output_tokens":40}}}`,
    );
    expect(e.tokensIn).toBe(300); // cumulative still summed for cost
    expect(e.contextTokens).toBe(200 + 4000 + 300 + 40); // last turn only
  });

  test("contextTokens ignores trailing API-error turns (no usage)", () => {
    const ok = `{"type":"assistant","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5000,"output_tokens":30}}}`;
    const err = `{"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error: 500"}]}}`;
    const e = parseClaudeTranscript(`${ok}\n${err}`);
    expect(e.contextTokens).toBe(10 + 5000 + 30); // last successful turn
  });

  test("errored = last API-error entry; later success clears it", () => {
    const errLine = `{"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error: 500"}]}}`;
    const okLine = `{"type":"assistant","isApiErrorMessage":false,"message":{"content":[{"type":"text","text":"done"}]}}`;
    expect(parseClaudeTranscript(errLine).errored).toBe(true);
    // a successful turn after the error clears the flag (explicit-false shape)
    expect(parseClaudeTranscript(`${errLine}\n${okLine}`).errored).toBeUndefined();
  });

  test("errored clears on a realistic success turn that OMITS isApiErrorMessage", () => {
    // Real successful Claude turns DO NOT carry isApiErrorMessage at all (the
    // explicit `false` above is a test artifact). The recency-bounded detection
    // must still clear the latch when a normal assistant turn follows the error.
    const errLine = `{"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error: 500"}]}}`;
    const okLine = `{"type":"assistant","message":{"content":[{"type":"text","text":"done, here is the result"}]}}`;
    expect(parseClaudeTranscript(errLine).errored).toBe(true);
    expect(parseClaudeTranscript(`${errLine}\n${okLine}`).errored).toBeUndefined();
    // crashReason rides errored: present while crashed, cleared on recovery.
    expect(parseClaudeTranscript(errLine).crashReason).toContain("API Error: 500");
    expect(parseClaudeTranscript(`${errLine}\n${okLine}`).crashReason).toBeUndefined();
  });

  test("errored preserved when the error is the LAST assistant turn (genuine crash)", () => {
    const okLine = `{"type":"assistant","message":{"content":[{"type":"text","text":"working on it"}]}}`;
    const errLine = `{"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error: 529 overloaded_error"}]}}`;
    const e = parseClaudeTranscript(`${okLine}\n${errLine}`);
    expect(e.errored).toBe(true);
    expect(e.crashReason).toContain("529");
  });

  test("errored clears across roles: error -> user turn -> successful assistant turn", () => {
    const errLine = `{"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error: 500"}]}}`;
    const userLine = `{"type":"user","message":{"content":[{"type":"text","text":"please retry"}]}}`;
    const okLine = `{"type":"assistant","message":{"content":[{"type":"text","text":"sure, done"}]}}`;
    // A user line between turns must NOT clear the error on its own…
    expect(parseClaudeTranscript(`${errLine}\n${userLine}`).errored).toBe(true);
    // …but a successful assistant turn after it does.
    expect(parseClaudeTranscript(`${errLine}\n${userLine}\n${okLine}`).errored).toBeUndefined();
  });

  test("active live status clears a stale transcript error in enrich (active guard)", async () => {
    // sessions/999.json status:busy => active. Its transcript ends in an API error,
    // but a session actively processing right now can never be crashed.
    const e = await claudePlugin.enrich!({ pid: 999 } as any, null, {
      home: ERR_FIX,
      startedAt: Date.now(),
      openFiles: [],
    });
    expect(e.active).toBe(true);
    expect(e.errored).toBeUndefined();
    expect(e.crashReason).toBeUndefined();
  });

  test("classifies transient vs persistent errors", () => {
    const err = (text: string, ts?: string) =>
      `{"type":"assistant","isApiErrorMessage":true,${ts ? `"timestamp":"${ts}",` : ""}"message":{"content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;
    // single known-transient blip (the classifier-unavailable case) => transient
    const t = parseClaudeTranscript(
      err("claude-opus-4-8[1m] is temporarily unavailable, so auto mode cannot determine the safety of Bash", "2026-06-16T19:12:00Z"),
    );
    expect(t.errored).toBe(true);
    expect(t.errorTransient).toBe(true);
    expect(t.errorAt).toBe(Date.parse("2026-06-16T19:12:00Z"));
    // unknown error text => persistent
    expect(parseClaudeTranscript(err("Tool failed: invalid state")).errorTransient).toBe(false);
    // sustained run of transient errors (>=3) => persistent
    const run = [err("Overloaded"), err("Overloaded"), err("Overloaded")].join("\n");
    expect(parseClaudeTranscript(run).errorTransient).toBe(false);
  });

  test("surfaces specific skill + subagent names", () => {
    const e = parseClaudeTranscript(
      `{"message":{"content":[` +
        `{"type":"tool_use","name":"Skill","input":{"skill":"brainstorming"}},` +
        `{"type":"tool_use","name":"Task","input":{"subagent_type":"Explore"}},` +
        `{"type":"tool_use","name":"Agent","input":{"subagent_type":"claude-code-guide"}},` +
        `{"type":"tool_use","name":"Bash"}` +
        `]}}`,
    );
    expect(e.toolsUsed).toEqual([
      "Skill:brainstorming",
      "Agent:Explore",
      "Agent:claude-code-guide",
      "Bash",
    ]);
  });

  test("surfaces CLIs invoked via the Bash tool", () => {
    const e = parseClaudeTranscript(
      `{"message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git push && gh pr create"}}]}}`,
    );
    expect(e.toolsUsed).toEqual(["Bash", "$git", "$gh"]);
  });

  test("uses pid->sessionId map + status (busy => active)", async () => {
    const e = await claudePlugin.enrich!({ pid: 999 } as any, null, {
      home: FIX,
      startedAt: Date.now(),
      openFiles: [],
    });
    expect(e.active).toBe(true); // status: busy in fixture sessions/999.json
    expect(e.tokensIn).toBe(2000); // resolved transcript via sessionId, not cwd birthtime
  });

  test("fresh session (transcript not written yet) never borrows a sibling's totals", async () => {
    // sessions/997.json names sessionId "freshsession", but freshsession.jsonl
    // does not exist yet (a new session writes no transcript until its first turn).
    // The same project dir holds a sibling transcript (session.jsonl, 2000 tok in).
    // enrich must NOT report the sibling's tokens — only the authoritative status.
    const e = await claudePlugin.enrich!({ pid: 997 } as any, null, {
      home: FIX,
      startedAt: Date.now(),
      openFiles: [],
    });
    expect(e.tokensIn).toBeUndefined(); // no transcript => no token totals
    expect(e.summary).toBeUndefined(); // and no borrowed summary
    expect(e.active).toBe(true); // status: busy still surfaces from meta
  });

  test("waiting status => needs attention (not active)", async () => {
    const e = await claudePlugin.enrich!({ pid: 998 } as any, null, {
      home: FIX,
      startedAt: Date.now(),
      openFiles: [],
    });
    expect(e.attention).toBe(true); // status: waiting => blocked on user
    expect(e.active).toBe(false);
  });

  test("reads transcript from disk", async () => {
    const e = await claudePlugin.enrich!({} as any, "/tmp/proj", {
      home: FIX,
      startedAt: Date.now(),
      openFiles: [],
    });
    expect(e.tokensIn).toBe(1200 + 800);
    expect(e.tokensCacheRead).toBe(300);
    expect(e.tokensOut).toBe(650);
    expect(e.toolsUsed).toEqual(["Read", "Edit"]);
    expect(e.summary).toBe("Building the mission control dashboard");
  });
});

describe("claude statusOnly freshness (stale 'active' aging)", () => {
  const TTL = 300_000; // 5 min
  const NOW = 1_700_000_000_000;

  test("(a) shell status with stale updatedAt (10min ago) => not active", () => {
    const e = statusOnly({ status: "shell", updatedAt: NOW - 10 * 60_000 }, NOW, TTL);
    expect(e.active).toBeFalsy();
  });

  test("(b) shell status with fresh updatedAt (30s ago) => active", () => {
    const e = statusOnly({ status: "shell", updatedAt: NOW - 30_000 }, NOW, TTL);
    expect(e.active).toBe(true);
  });

  test("(c) busy fresh => active; idle => not active (baseline unchanged)", () => {
    expect(statusOnly({ status: "busy", updatedAt: NOW - 5_000 }, NOW, TTL).active).toBe(true);
    expect(statusOnly({ status: "idle", updatedAt: NOW }, NOW, TTL).active).toBe(false);
  });

  test("(d) waiting status STALE => attention still true (attention is NOT aged)", () => {
    const e = statusOnly({ status: "waiting", updatedAt: NOW - 9 * 60 * 60_000 }, NOW, TTL);
    expect(e.attention).toBe(true);
    expect(e.active).toBe(false);
  });

  test("(e) statusUpdatedAt preferred over updatedAt when both present", () => {
    // statusUpdatedAt is fresh, updatedAt is stale => statusUpdatedAt wins => active
    expect(
      statusOnly(
        { status: "busy", statusUpdatedAt: NOW - 10_000, updatedAt: NOW - 10 * 60_000 },
        NOW,
        TTL,
      ).active,
    ).toBe(true);
    // statusUpdatedAt is stale, updatedAt is fresh => statusUpdatedAt wins => not active
    expect(
      statusOnly(
        { status: "busy", statusUpdatedAt: NOW - 10 * 60_000, updatedAt: NOW - 10_000 },
        NOW,
        TTL,
      ).active,
    ).toBeFalsy();
  });

  test("no timestamp at all => trust status as-is (legacy files; no false demotion)", () => {
    // A status file with neither statusUpdatedAt nor updatedAt has no recency to
    // consult, so busy/shell stays active rather than being demoted on a guess.
    expect(statusOnly({ status: "busy" }, NOW, TTL).active).toBe(true);
    expect(statusOnly({ status: "shell" }, NOW, TTL).active).toBe(true);
  });
});

describe("codex enrichment", () => {
  test("parseCodexRollout: tokens (cached split), tools, model, recap text", () => {
    const lines = [
      { type: "session_meta", payload: { type: "session_meta", cwd: "/x", model: "gpt-5.5" } },
      { type: "event_msg", payload: { type: "user_message", message: "review this PR" } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command" } },
      { type: "event_msg", payload: { type: "agent_message", message: "Reviewing the diff now." } },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 120 } },
        },
      },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n");
    const e = parseCodexRollout(lines);
    expect(e.tokensIn).toBe(400); // 1000 - 600 cached
    expect(e.tokensCacheRead).toBe(600);
    expect(e.tokensOut).toBe(120);
    expect(e.model).toBe("gpt-5.5");
    expect(e.toolsUsed).toEqual(["exec_command"]);
    expect(e.summary).toBe("Reviewing the diff now.");
    expect(e.summaryInput).toContain("user: review this PR");
    expect(e.summaryInput).toContain("assistant: Reviewing the diff now.");
  });

  test("parseCodexRollout: context occupancy from last_token_usage + native window", () => {
    const lines = [
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 99999, output_tokens: 9999, total_tokens: 109998 },
            last_token_usage: { input_tokens: 14668, cached_input_tokens: 10112, output_tokens: 690, total_tokens: 15358 },
            model_context_window: 258400,
          },
        },
      },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n");
    const e = parseCodexRollout(lines);
    expect(e.contextTokens).toBe(15358); // last turn working set, not the 109998 cumulative
    expect(e.contextWindow).toBe(258400); // codex reports its own window
  });

  // Spins up a throwaway $HOME with one rollout (matched by cwd) plus a hook
  // state file, runs enrich, and tears down. `state` is the JSON the mc-codex
  // hook would have written for the session.
  async function enrichWithState(dirName: string, state: Record<string, unknown>) {
    const home = join(import.meta.dir, "..", "fixtures", dirName);
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const sessDir = join(home, ".codex", "sessions", "2026", "06", "16");
    const stateDir = join(home, ".mission-control", "codex");
    mkdirSync(sessDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const uuid = "019ed0bb-0645-77a0-abe7-6afd5fd9683c";
    writeFileSync(
      join(sessDir, `rollout-2026-06-16T10-00-00-${uuid}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { type: "session_meta", cwd: "/repo", id: uuid } }) + "\n",
    );
    writeFileSync(join(stateDir, `${uuid}.json`), JSON.stringify(state));
    try {
      return await codexPlugin.enrich!({} as any, "/repo", { home, startedAt: Date.now(), openFiles: [] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("attention set from hook state file matched by cwd", async () => {
    const e = await enrichWithState("codex-attn-home", { attention: true, at: Date.now(), cwd: "/repo" });
    expect(e.attention).toBe(true);
  });

  test("active=true from hook state file (authoritative processing flag)", async () => {
    const e = await enrichWithState("codex-active-home", {
      active: true,
      attention: false,
      at: Date.now(),
      cwd: "/repo",
    });
    expect(e.active).toBe(true);
    expect(e.attention).toBeUndefined();
  });

  test("active=false from hook state (Stop) overrides the recent-mtime heuristic", async () => {
    // The rollout file is freshly written, so the mtime fallback would read as
    // active — the authoritative Stop flag must win and pin it idle.
    const e = await enrichWithState("codex-idle-home", {
      active: false,
      attention: false,
      at: Date.now(),
      cwd: "/repo",
    });
    expect(e.active).toBe(false);
  });

  test("legacy state without an active field leaves active undefined (mtime fallback)", async () => {
    const e = await enrichWithState("codex-legacy-home", { attention: true, at: Date.now(), cwd: "/repo" });
    expect(e.attention).toBe(true);
    expect(e.active).toBeUndefined();
  });

  test("stale state (>6h) is ignored", async () => {
    const e = await enrichWithState("codex-stale-home", {
      active: true,
      attention: true,
      at: Date.now() - 7 * 3600_000,
      cwd: "/repo",
    });
    expect(e.active).toBeUndefined();
    expect(e.attention).toBeUndefined();
  });
});

describe("opencode enrichment", () => {
  test("assembleOpencode orders messages and builds recap input", () => {
    const e = assembleOpencode([
      { role: "assistant", created: 2, modelID: "grok-code", texts: ["On it."] },
      { role: "user", created: 1, texts: ["fix the bug"] },
    ]);
    expect(e.model).toBe("grok-code");
    expect(e.summary).toBe("On it.");
    expect(e.summaryInput).toBe("user: fix the bug\nassistant: On it.");
  });
});

describe("hermes enrichment", () => {
  test("assembleHermes maps session tokens + builds recap", () => {
    const e = assembleHermes(
      {
        model: "claude-opus-4-7",
        title: "Vault maintenance",
        input_tokens: 500,
        output_tokens: 80,
        cache_read_tokens: 1200,
      },
      [
        { role: "user", content: "organize my notes" },
        { role: "assistant", content: "Sorted them into folders." },
        { role: "user", content: 42 }, // non-string ignored
      ],
    );
    expect(e.model).toBe("claude-opus-4-7");
    expect(e.tokensIn).toBe(500);
    expect(e.tokensCacheRead).toBe(1200);
    expect(e.tokensOut).toBe(80);
    expect(e.summary).toBe("Vault maintenance");
    expect(e.summaryInput).toBe("user: organize my notes\nassistant: Sorted them into folders.");
  });
});

describe("pi enrichment", () => {
  test("parsePiSession: tokens, own cost, tools, recap", () => {
    const e = parsePiSession(
      `{"type":"session","cwd":"/p"}\n` +
        `{"type":"message","message":{"role":"user","content":"add a test"}}\n` +
        `{"type":"message","message":{"role":"assistant","model":"gpt-5","content":[` +
        `{"type":"text","text":"Adding it."},{"type":"toolCall","name":"bash"}],` +
        `"usage":{"input":100,"cacheRead":500,"output":20,"cost":{"total":0.0123}}}}`,
    );
    expect(e.tokensIn).toBe(100);
    expect(e.tokensCacheRead).toBe(500);
    expect(e.tokensOut).toBe(20);
    expect(e.costUsd).toBe(0.0123); // pi's own cost, used as-is
    expect(e.model).toBe("gpt-5");
    expect(e.toolsUsed).toEqual(["bash"]);
    expect(e.summaryInput).toBe("user: add a test\nassistant: Adding it.");
  });

  test("errored when last assistant stopReason is error", () => {
    const e = parsePiSession(
      `{"type":"message","message":{"role":"assistant","content":[],"stopReason":"error"}}`,
    );
    expect(e.errored).toBe(true);
  });
});

describe("openclaw enrichment", () => {
  test("resolves newest session from sessions.json and parses claude-shaped jsonl", async () => {
    const e = await openclawPlugin.enrich!({} as any, null, {
      home: FIX,
      startedAt: Date.now(),
      openFiles: [],
    });
    expect(e.model).toBe("claude-opus-4-8");
    expect(e.providerSessionId).toBe("oc1"); // stable native id, off the synthetic key path
    expect(e.tokensIn).toBe(300);
    expect(e.tokensCacheRead).toBe(1000);
    expect(e.toolsUsed).toEqual(["Bash"]);
    expect(e.summaryInput).toContain("user: deploy the service");
  });
});

describe("collect", () => {
  const cfg: ReporterConfig = {
    serverUrl: "ws://x",
    token: "t",
    hostId: "h1",
    hostLabel: "host-1",
    home: FIX,
    intervalMs: 3000,
    activeTtlMs: 300_000,
    categories: { byCwd: [{ match: /proj/, category: "code" }] },
    summaries: { enabled: false, model: "claude-haiku-4-5", minIntervalMs: 60_000 },
  };

  test("builds sessions with enrichment + cost", async () => {
    const procs = [
      { pid: 501, ppid: 1, uptimeSec: 60, cpu: 2, memMb: 100, comm: "claude", args: "claude" },
      { pid: 777, ppid: 1, uptimeSec: 5, cpu: 0, memMb: 5, comm: "bash", args: "-bash" },
    ];
    const report = await collect(procs, cfg, {
      inspect: async () => ({ cwd: "/tmp/proj", openFiles: [] }),
      now: () => 1_000_000,
    });
    expect(report.sessions).toHaveLength(1);
    const s = report.sessions[0]!;
    expect(s.id).toBe("h1:501");
    expect(s.provider).toBe("claude");
    expect(s.category).toBe("code");
    expect(s.startedAt).toBe(1_000_000 - 60_000);
    expect(s.tokensIn).toBe(2000);
    expect(s.tokensCacheRead).toBe(300);
    expect(s.costUsd).toBeGreaterThan(0);
  });

  test("LLM recap overrides heuristic summary when summarizer active", async () => {
    const { Summarizer } = await import("./summarizer.ts");
    const summarizer = new Summarizer(async () => ({ summary: "Building the dashboard reporter" }), {
      minIntervalMs: 0,
    });
    const procs = [
      { pid: 501, ppid: 1, uptimeSec: 60, cpu: 2, memMb: 100, comm: "claude", args: "claude" },
    ];
    const deps = { inspect: async () => ({ cwd: "/tmp/proj", openFiles: [] }), now: () => 1, summarizer };
    // first tick schedules the recap; heuristic summary shows meanwhile
    let report = await collect(procs, cfg, deps);
    expect(report.sessions[0]!.summary).toBe("Building the mission control dashboard");
    await summarizer.settle();
    // next tick picks up the LLM recap
    report = await collect(procs, cfg, deps);
    expect(report.sessions[0]!.summary).toBe("Building the dashboard reporter");
  });

  test("stamps templateId from the templateId dep onto the session", async () => {
    const procs = [
      { pid: 501, ppid: 1, uptimeSec: 60, cpu: 2, memMb: 100, comm: "claude", args: "claude" },
    ];
    const report = await collect(procs, cfg, {
      inspect: async () => ({ cwd: "/tmp/proj", openFiles: [] }),
      now: () => 1_000_000,
      templateId: async () => "feat",
    });
    expect(report.sessions[0]!.templateId).toBe("feat");
  });

  test("omitting the templateId dep leaves session.templateId unset (guard)", async () => {
    const procs = [
      { pid: 501, ppid: 1, uptimeSec: 60, cpu: 2, memMb: 100, comm: "claude", args: "claude" },
    ];
    const report = await collect(procs, cfg, {
      inspect: async () => ({ cwd: "/tmp/proj", openFiles: [] }),
      now: () => 1_000_000,
    });
    expect(report.sessions[0]!.templateId).toBeUndefined();
  });

  test("awaitingUser from the model flags attention on an idle session", async () => {
    const { Summarizer } = await import("./summarizer.ts");
    const summarizer = new Summarizer(async () => ({ summary: "asked a question", awaitingUser: true }), {
      minIntervalMs: 0,
    });
    const procs = [
      { pid: 501, ppid: 1, uptimeSec: 60, cpu: 2, memMb: 100, comm: "claude", args: "claude" },
    ];
    const deps = { inspect: async () => ({ cwd: "/tmp/proj", openFiles: [] }), now: () => 1, summarizer };
    await collect(procs, cfg, deps); // schedule
    await summarizer.settle();
    const report = await collect(procs, cfg, deps);
    expect(report.sessions[0]!.attention).toBe(true);
  });
});
