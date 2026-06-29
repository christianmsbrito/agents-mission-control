import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderPlugin, Enrichment, EnrichContext } from "./types.ts";
import type { ProcInfo } from "../procscan.ts";
import { parseClaudeTranscript } from "./claude.ts";

async function readJson(path: string): Promise<any | null> {
  try {
    return JSON.parse(await Bun.file(path).text());
  } catch {
    return null;
  }
}

/**
 * OpenClaw is a daemon wrapping coding agents. Each agent keeps
 * `agents/<agent>/sessions/sessions.json` (a map of session-key -> {sessionId,
 * updatedAt}) plus `<sessionId>.jsonl` transcripts. It's a single gateway, so
 * we use the most-recently-updated session across all agents.
 */
async function newestSessionFile(
  home: string,
): Promise<{ file: string; updatedAt: number; sessionId: string } | null> {
  const agentsDir = join(home, ".openclaw", "agents");
  let agents: string[];
  try {
    agents = await readdir(agentsDir);
  } catch {
    return null;
  }
  let best: { file: string; updatedAt: number; sessionId: string } | null = null;
  for (const a of agents) {
    const sessDir = join(agentsDir, a, "sessions");
    const map = await readJson(join(sessDir, "sessions.json"));
    if (!map || typeof map !== "object") continue;
    for (const entry of Object.values<any>(map)) {
      const updatedAt = entry?.updatedAt ?? 0;
      if (entry?.sessionId && (!best || updatedAt > best.updatedAt)) {
        best = { file: join(sessDir, `${entry.sessionId}.jsonl`), updatedAt, sessionId: entry.sessionId };
      }
    }
  }
  return best;
}

export const openclawPlugin: ProviderPlugin = {
  id: "openclaw",
  defaultCategory: "personal",
  matchProcess(p: ProcInfo) {
    return /(^|[\s/])openclaw([\s/._-]|$)/i.test(p.args) || p.comm === "openclaw";
  },
  async enrich(_p, _cwd, ctx: EnrichContext): Promise<Enrichment> {
    const newest = await newestSessionFile(ctx.home);
    if (!newest) return {};
    let text: string;
    try {
      text = await Bun.file(newest.file).text();
    } catch {
      return {};
    }
    // OpenClaw transcripts use the same {message:{role,content,usage}} shape as claude.
    const out = parseClaudeTranscript(text);
    // Expose the stable native session id so persistence keys this daemon by it
    // instead of the synthetic ${host}:${pid}:${startedAt} key (which drifts with
    // sub-second startedAt jitter). Aligns the live key with backfill's keying.
    out.providerSessionId = newest.sessionId;
    try {
      out.lastActivityAt = (await stat(newest.file)).mtimeMs;
    } catch {
      out.lastActivityAt = newest.updatedAt || undefined;
    }
    return out;
  },
};
