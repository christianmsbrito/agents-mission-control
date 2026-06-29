// Registers the Mission Control Claude Code prompt/completion hook in ~/.claude/settings.json.
// Idempotent + additive: preserves existing hooks, backs up before writing.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOOK = join(import.meta.dir, "..", "hooks", "mc-agent-prompt-hook.ts");
const SETTINGS_PATH =
  process.env.MC_CLAUDE_SETTINGS_PATH || join(homedir(), ".claude", "settings.json");
const EVENTS = ["UserPromptSubmit", "Stop"];
const DRY_RUN = Bun.argv.includes("--dry-run");

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const command = `MC_AGENT_PROVIDER=claude ${shellQuote(process.execPath)} ${shellQuote(HOOK)}`;

type HookCommand = {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
};

type HookGroup = {
  hooks?: HookCommand[];
  [key: string]: unknown;
};

function isMcClaudeHook(hook: HookCommand): boolean {
  const value = hook?.command;
  return (
    typeof value === "string" &&
    value.includes("mc-agent-prompt-hook.ts") &&
    value.includes("MC_AGENT_PROVIDER=claude")
  );
}

function stripMcClaudeHooks(groups: unknown): HookGroup[] {
  if (!Array.isArray(groups)) return [];
  const next: HookGroup[] = [];
  for (const group of groups) {
    if (!group || typeof group !== "object" || !Array.isArray((group as HookGroup).hooks)) {
      next.push(group as HookGroup);
      continue;
    }
    const hooks = ((group as HookGroup).hooks ?? []).filter((hook) => !isMcClaudeHook(hook));
    if (hooks.length > 0) next.push({ ...(group as HookGroup), hooks });
  }
  return next;
}

const original = existsSync(SETTINGS_PATH) ? await Bun.file(SETTINGS_PATH).text() : "";
let config: any;
try {
  config = original ? JSON.parse(original) : { hooks: {} };
} catch (err) {
  throw new Error(
    `Could not parse ${SETTINGS_PATH}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

config.hooks ??= {};

for (const event of Object.keys(config.hooks)) {
  const nextGroups = stripMcClaudeHooks(config.hooks[event]);
  if (nextGroups.length > 0) config.hooks[event] = nextGroups;
  else delete config.hooks[event];
}

for (const event of EVENTS) {
  (config.hooks[event] ??= []).push({
    hooks: [{ type: "command", command, timeout: 5 }],
  });
}

const next = JSON.stringify(config, null, 2) + "\n";

if (next === original) {
  if (!DRY_RUN) chmodSync(HOOK, 0o755);
  console.log("[install] mc-claude hook already registered - nothing to do.");
} else if (DRY_RUN) {
  console.log(`[install] dry run: would register mc-claude hook for ${EVENTS.join(", ")}.`);
  console.log(`[install] settings: ${SETTINGS_PATH}`);
  console.log(`[install] command: ${command}`);
} else {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  if (original) await Bun.write(`${SETTINGS_PATH}.mc.bak`, original);
  await Bun.write(SETTINGS_PATH, next);
  chmodSync(HOOK, 0o755);
  console.log(`[install] registered mc-claude hook for ${EVENTS.join(", ")} in ${SETTINGS_PATH}`);
  if (original) console.log(`[install] backup: ${SETTINGS_PATH}.mc.bak`);
  console.log("[install] restart any running Claude Code sessions to load the hook.");
}
