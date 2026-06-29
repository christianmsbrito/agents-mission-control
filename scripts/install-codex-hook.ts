// Registers the Mission Control codex attention hook in ~/.codex/hooks.json.
// Idempotent + additive: preserves existing hooks, backs up before writing.
import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync } from "node:fs";

const HOOK = join(import.meta.dir, "..", "hooks", "mc-codex-attention.sh");
const PROMPT_HOOK = join(import.meta.dir, "..", "hooks", "mc-agent-prompt-hook.ts");
const SET_EVENT = "PermissionRequest"; // codex is about to ask for approval
const CLEAR_EVENTS = ["PostToolUse", "Stop", "UserPromptSubmit", "SessionEnd"];
const EVENTS = [SET_EVENT, ...CLEAR_EVENTS];

const path = join(homedir(), ".codex", "hooks.json");
const original = existsSync(path) ? await Bun.file(path).text() : "";
const config: any = original ? JSON.parse(original) : { hooks: {} };
config.hooks ??= {};

const isMcHook = (g: any) =>
  g?.hooks?.some((h: any) => String(h?.command ?? "").includes("mc-codex-attention.sh"));

// Strip any prior mc-codex-attention.* entries (handles path/extension changes), then re-add.
for (const event of Object.keys(config.hooks)) {
  config.hooks[event] = (config.hooks[event] ?? []).filter((g: any) => !isMcHook(g));
  if (config.hooks[event].length === 0) delete config.hooks[event];
}
for (const event of EVENTS) {
  (config.hooks[event] ??= []).push({ hooks: [{ type: "command", command: HOOK }] });
}

const next = JSON.stringify(config, null, 2) + "\n";
if (next === original) {
  console.log("[install] mc-codex hook already registered — nothing to do.");
} else {
  if (original) await Bun.write(`${path}.mc.bak`, original);
  await Bun.write(path, next);
  chmodSync(HOOK, 0o755);
  chmodSync(PROMPT_HOOK, 0o755);
  console.log(`[install] registered mc-codex hook for ${EVENTS.length} events in ${path}`);
  console.log(`[install] backup: ${path}.mc.bak  |  hook: ${HOOK}`);
  console.log("[install] restart any running codex sessions to load the hook.");
}
