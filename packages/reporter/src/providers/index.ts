import type { ProviderPlugin } from "./types.ts";
import type { ProcInfo } from "../procscan.ts";
import { claudePlugin } from "./claude.ts";
import { codexPlugin } from "./codex.ts";
import { opencodePlugin } from "./opencode.ts";
import { openclawPlugin } from "./openclaw.ts";
import { hermesPlugin } from "./hermes.ts";
import { piPlugin } from "./pi.ts";

/** Order matters: more specific first. First match wins. */
export const REGISTRY: ProviderPlugin[] = [
  claudePlugin,
  codexPlugin,
  opencodePlugin,
  openclawPlugin,
  hermesPlugin,
  piPlugin,
];

export function matchProvider(p: ProcInfo): ProviderPlugin | undefined {
  return REGISTRY.find((plugin) => plugin.matchProcess(p));
}

export type { ProviderPlugin, Enrichment, EnrichContext } from "./types.ts";
