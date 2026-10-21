import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderPlugin, Enrichment, EnrichContext } from "./types.ts";
import type { ProcInfo } from "../procscan.ts";
import { extractClis, commandFromInput } from "../clis.ts";

/**
 * Parse a pi coding-agent session JSONL.
 * Header line: {type:"session", cwd, ...}. Message lines: {type:"message",
 * message:{role, content, model, usage:{input,output,cacheRead,cost:{total}}}}.
 * (earendil-works/pi — based on its documented session format.)
 */
export function parsePiSession(text: string): Enrichment {
  let model: string | undefined;
  let summary: string | undefined;
  let tokensIn = 0;
  let tokensCacheRead = 0;
  let tokensCacheWrite = 0;
  let tokensOut = 0;
  let contextTokens = 0; // last turn's working set = live window occupancy
  let cost = 0;
  let sawCost = false;
  let errored = false; // last assistant turn's stopReason
  const tools = new Set<string>();
  const convo: string[] = [];

  const pushText = (role: string, content: unknown) => {
    let text: string | undefined;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join(" ");
    }
    if (text && text.trim()) {
      convo.push(`${role}: ${text}`);
      if (role === "assistant") summary = text.slice(0, 140);
      else summary ??= text.slice(0, 140);
    }
  };

  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev.type !== "message") continue;
    const m = ev.message;
    if (!m?.role) continue;

    if (m.role === "assistant") {
      if (typeof m.model === "string") model = m.model;
      if (typeof m.stopReason === "string") errored = m.stopReason === "error";
      if (m.usage) {
        const fresh = m.usage.input ?? 0;
        const cacheRead = m.usage.cacheRead ?? 0;
        const cacheWrite = m.usage.cacheWrite ?? 0;
        const out = m.usage.output ?? 0;
        tokensIn += fresh;
        tokensCacheRead += cacheRead;
        tokensCacheWrite += cacheWrite;
        tokensOut += out;
        contextTokens = fresh + cacheRead + cacheWrite + out; // last turn wins

        const c = m.usage.cost?.total;
        if (typeof c === "number") {
          cost += c;
          sawCost = true;
        }
      }
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c?.type === "toolCall" && typeof c.name === "string") {
            if (c.name === "Skill" && typeof c.arguments?.skill === "string") {
              tools.add(`Skill:${c.arguments.skill}`);
            } else {
              tools.add(c.name);
              if (/bash|shell|exec/i.test(c.name)) {
                const cmd = commandFromInput(c.arguments);
                if (cmd) for (const cli of extractClis(cmd)) tools.add(`$${cli}`);
              }
            }
          }
        }
      }
      pushText("assistant", m.content);
    } else if (m.role === "user") {
      pushText("user", m.content);
    }
  }

  const out: Enrichment = { tokensIn, tokensCacheRead, tokensCacheWrite, tokensOut };
  if (contextTokens) out.contextTokens = contextTokens;
  if (model) out.model = model;
  if (summary) out.summary = summary;
  if (sawCost) out.costUsd = Math.round(cost * 10000) / 10000;
  if (errored) out.errored = true;
  if (tools.size) out.toolsUsed = [...tools];
  if (convo.length) {
    out.summaryInput = convo.slice(-12).join("\n");
    const opening = convo.filter((c) => c.startsWith("user:")).slice(0, 3);
    if (opening.length) out.subjectInput = opening.join("\n").slice(0, 2000);
  }
  return out;
}

async function headerCwd(path: string): Promise<string | null> {
  try {
    const head = await Bun.file(path).slice(0, 4096).text();
    const line = head.split("\n").find((l) => l.trim());
    const o = line ? JSON.parse(line) : null;
    return o?.type === "session" ? (o.cwd ?? null) : null;
  } catch {
    return null;
  }
}

/** Session file matching `cwd`, born closest to the process start. Robust to dir-name encoding. */
async function findSession(home: string, cwd: string | null, startedAt: number): Promise<string | null> {
  if (!cwd) return null;
  const root = join(home, ".pi", "agent", "sessions");
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch {
    return null;
  }
  const files = entries.filter((e) => e.endsWith(".jsonl")).map((e) => join(root, e));
  let best: { path: string; delta: number } | null = null;
  for (const f of files) {
    if ((await headerCwd(f)) !== cwd) continue;
    try {
      const born = (await stat(f)).birthtimeMs || (await stat(f)).ctimeMs;
      const delta = Math.abs(born - startedAt);
      if (!best || delta < best.delta) best = { path: f, delta };
    } catch {
      /* skip */
    }
  }
  return best?.path ?? null;
}

export const piPlugin: ProviderPlugin = {
  id: "pi",
  defaultCategory: "personal",
  needsOpenFiles: true, // finds its session file via lsof
  matchProcess(p: ProcInfo) {
    return /(^|\/)pi(\s|$)/.test(p.args) || p.comm === "pi";
  },
  async enrich(_p, cwd, ctx: EnrichContext): Promise<Enrichment> {
    // Prefer the session file the process has open; else match by header cwd.
    const open = ctx.openFiles.find((f) => f.includes("/.pi/agent/sessions/") && f.endsWith(".jsonl"));
    const file = open ?? (await findSession(ctx.home, cwd, ctx.startedAt));
    if (!file) return {};
    let text: string;
    try {
      text = await Bun.file(file).text();
    } catch {
      return {};
    }
    const out = parsePiSession(text);
    try {
      out.lastActivityAt = (await stat(file)).mtimeMs;
    } catch {
      /* ignore */
    }
    return out;
  },
};
