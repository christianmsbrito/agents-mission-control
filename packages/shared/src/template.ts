/** Where a deployed troop's pane is created. `iterm2` = native iTerm2 split
 * panes (macOS, matches the user's terminal look); `tmux` = tmux windows/panes
 * (persistent, works headless/remote). */
export type SpawnBackend = "iterm2" | "tmux";
export const SPAWN_BACKENDS: SpawnBackend[] = ["iterm2", "tmux"];
export const DEFAULT_BACKEND: SpawnBackend = "iterm2";

/** A spawn template: a reusable recipe for deploying an agent session. */
export type Template = {
  id: string;
  name: string;
  provider: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  /** Pane backend for deploys (defaults to iterm2). */
  backend: SpawnBackend;
  /** Free-form RPG card metadata (class/sprite/color). */
  rpg?: Record<string, unknown>;
  createdAt: number;
  archivedAt?: number;
};

/** A template plus its derived XP rollup (computed on read, never stored). */
export type TemplateWithXp = Template & {
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
  backend?: unknown;
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
  if (raw.backend !== undefined && raw.backend !== null && !SPAWN_BACKENDS.includes(raw.backend as SpawnBackend))
    return { ok: false, error: "backend must be iterm2 | tmux" };
  const id = (typeof raw.id === "string" && raw.id.trim() ? slugify(raw.id) : slugify(raw.name));
  if (!id) return { ok: false, error: "could not derive id" };
  const value: Omit<Template, "createdAt" | "archivedAt"> = {
    id,
    name: raw.name.trim(),
    provider: raw.provider.trim(),
    args,
    backend: SPAWN_BACKENDS.includes(raw.backend as SpawnBackend) ? (raw.backend as SpawnBackend) : DEFAULT_BACKEND,
  };
  if (typeof raw.prompt === "string" && raw.prompt) value.prompt = raw.prompt;
  if (typeof raw.cwd === "string" && raw.cwd) value.cwd = raw.cwd;
  if (raw.rpg && typeof raw.rpg === "object") value.rpg = raw.rpg as Record<string, unknown>;
  return { ok: true, value };
}

/** XP → level. Derived; simple log-ish curve over troops + tokens. Pure. */
export function templateLevel(troopsDeployed: number, totalTokens: number): number {
  const xp = troopsDeployed * 100 + Math.floor(totalTokens / 10_000);
  return Math.max(1, Math.floor(Math.sqrt(xp / 25)) + 1);
}
