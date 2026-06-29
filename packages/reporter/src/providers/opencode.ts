import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderPlugin, Enrichment, EnrichContext } from "./types.ts";
import type { ProcInfo } from "../procscan.ts";

/** A normalized OpenCode message for assembling a recap. */
export type OcMessage = { role: string; created: number; modelID?: string; texts: string[] };

/** Pure: turn ordered messages into enrichment. */
export function assembleOpencode(messages: OcMessage[]): Enrichment {
  const sorted = [...messages].sort((a, b) => a.created - b.created);
  const convo: string[] = [];
  let model: string | undefined;
  let summary: string | undefined;
  for (const m of sorted) {
    if (m.modelID) model = m.modelID;
    for (const text of m.texts) {
      if (!text.trim()) continue;
      convo.push(`${m.role}: ${text}`);
      if (m.role === "assistant") summary = text.slice(0, 140);
      else summary ??= text.slice(0, 140);
    }
  }
  const out: Enrichment = {};
  if (model) out.model = model;
  if (summary) out.summary = summary;
  if (convo.length) out.summaryInput = convo.slice(-12).join("\n");
  return out;
}

async function readJson(path: string): Promise<any | null> {
  try {
    return JSON.parse(await Bun.file(path).text());
  } catch {
    return null;
  }
}

/** Newest session whose `directory` matches cwd. */
async function findSession(base: string, cwd: string | null) {
  if (!cwd) return null;
  const dir = join(base, "session");
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return null;
  }
  let best: { id: string; updated: number } | null = null;
  for (const e of entries) {
    if (!e.endsWith(".json")) continue;
    const s = await readJson(join(dir, e));
    if (s?.directory === cwd && typeof s.id === "string") {
      const updated = s.time?.updated ?? 0;
      if (!best || updated > best.updated) best = { id: s.id, updated };
    }
  }
  return best;
}

/** Load recent messages (+ their text parts) for a session. */
async function loadMessages(base: string, sessionId: string): Promise<OcMessage[]> {
  const msgDir = join(base, "message", sessionId);
  let files: string[];
  try {
    files = (await readdir(msgDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const metas = (await Promise.all(files.map((f) => readJson(join(msgDir, f)))))
    .filter((m) => m?.id)
    .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))
    .slice(0, 12); // newest 12 messages

  const out: OcMessage[] = [];
  for (const m of metas) {
    const partDir = join(base, "part", m.id);
    let parts: string[] = [];
    try {
      parts = (await readdir(partDir)).filter((f) => f.endsWith(".json"));
    } catch {
      /* no parts */
    }
    const texts: string[] = [];
    for (const pf of parts) {
      const p = await readJson(join(partDir, pf));
      if (p?.type === "text" && typeof p.text === "string") texts.push(p.text);
    }
    out.push({ role: m.role ?? "user", created: m.time?.created ?? 0, modelID: m.model?.modelID, texts });
  }
  return out;
}

export const opencodePlugin: ProviderPlugin = {
  id: "opencode",
  defaultCategory: "code",
  matchProcess(p: ProcInfo) {
    return /(^|\/)opencode(\s|$)/.test(p.args) || p.comm === "opencode";
  },
  async enrich(_p, cwd, ctx: EnrichContext): Promise<Enrichment> {
    const base = join(ctx.home, ".local", "share", "opencode", "storage");
    const session = await findSession(base, cwd);
    if (!session) return {};
    const out = assembleOpencode(await loadMessages(base, session.id));
    if (session.updated) out.lastActivityAt = session.updated;
    return out;
  },
};
