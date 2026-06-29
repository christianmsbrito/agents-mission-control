import Anthropic from "@anthropic-ai/sdk";
import type { Session } from "@mc/shared";
import type { DisplayNameGenerator } from "./aliases.ts";

const SCHEMA = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
} as const;

const SYSTEM =
  "Name a live AI coding-agent session for a mission-control dashboard. " +
  "Return JSON with a single field, name. The name must be exactly one short, meaningful word. " +
  "No spaces, no dashes, no punctuation, no emoji. Prefer concrete nouns or verbs.";

export function normalizeDisplayName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const first = raw.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const cleaned = first.replace(/[^a-z0-9]/g, "").slice(0, 18);
  return cleaned.length >= 2 ? cleaned : undefined;
}

/** Build a Haiku-backed display-name generator, or undefined when disabled/unconfigured. */
export function haikuDisplayNameGenerator(
  env: Record<string, string | undefined> = process.env,
): DisplayNameGenerator | undefined {
  if (!env.ANTHROPIC_API_KEY || env.MC_ALIAS_NAMES === "0") return undefined;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.MC_ALIAS_MODEL || env.MC_SUMMARY_MODEL || "claude-haiku-4-5";

  return async (session: Session) => {
    const msg = await client.messages.create({
      model,
      max_tokens: 60,
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            `provider: ${session.provider}`,
            `cwd: ${session.cwd ?? ""}`,
            `subject: ${session.subject ?? ""}`,
            `summary: ${session.summary ?? ""}`,
          ].join("\n"),
        },
      ],
    });
    const block = msg.content.find((b) => b.type === "text");
    if (block?.type !== "text") return undefined;
    try {
      const parsed = JSON.parse(block.text);
      return normalizeDisplayName(typeof parsed.name === "string" ? parsed.name : undefined);
    } catch {
      return normalizeDisplayName(block.text);
    }
  };
}
