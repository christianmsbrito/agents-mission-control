import type { AgentTask, Session } from "@mc/shared";

export type AliasDirective = { to: string; text: string; verb?: string };

export function canonicalHandle(value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (/^mc:a\d+$/i.test(s)) return s.toLowerCase();
  if (/^a\d+$/i.test(s)) return `mc:${s.toLowerCase()}`;
  return null;
}

export function compactText(value: unknown, max = 3000): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Minimal terminal grammar:
 * - `ask mc:a3 what service x does`
 * - `tell mc:a3 check the failing test`
 * - `ping mc:a3`
 * - `mc:a3 what are you working on?`
 */
export function parseAliasDirective(prompt: string): AliasDirective | null {
  const text = compactText(prompt);
  if (!text) return null;

  const withVerb = text.match(/^(ask|tell|ping)\s+(mc:a\d+|a\d+)\b[:,]?\s*(.*)$/i);
  if (withVerb) {
    const to = canonicalHandle(withVerb[2]);
    if (!to) return null;
    const verb = withVerb[1]!.toLowerCase();
    const rest = compactText(withVerb[3]);
    return { to, text: rest || verb, verb };
  }

  const direct = text.match(/^(mc:a\d+|a\d+)\b[:,]?\s*(.*)$/i);
  if (direct) {
    const to = canonicalHandle(direct[1]);
    const rest = compactText(direct[2]);
    if (!to || !rest) return null;
    return { to, text: rest };
  }

  return null;
}

export function buildAskPrompt(task: AgentTask): string {
  const from = task.from ?? "Mission Control";
  return (
    `[Mission Control task ${task.id}]\n` +
    `Source: ${from}\n` +
    `Request:\n` +
    `<mission-control-request>\n${compactText(task.text)}\n</mission-control-request>\n\n` +
    `Answer the request directly in your next assistant message. Mission Control will route your final answer back automatically. ` +
    `Do not try to contact ${from}, do not call routing tools, and do not troubleshoot Mission Control unless the request asks you to.`
  );
}

export function buildReplyPrompt(task: AgentTask): string {
  return (
    `[Mission Control delivery ${task.id}]\n` +
    `A user prompt in this terminal was intercepted before it reached you and routed to ${task.to}.\n` +
    `Original intercepted prompt:\n` +
    `<mission-control-request>\n${compactText(task.text)}\n</mission-control-request>\n\n` +
    `Answer from ${task.to}:\n` +
    `<mission-control-reply>\n${compactText(task.reply)}\n</mission-control-reply>\n\n` +
    `This delivery is the result of that intercepted prompt, so it may not appear in your prior conversation memory. ` +
    `Use the delivered answer as the result for this task and present it to the user concisely.`
  );
}

export function routedContext(task: AgentTask): string {
  return (
    `Mission Control routed this prompt to ${task.to} as ${task.id}. ` +
    `This local prompt was blocked so you do not answer on behalf of ${task.to}. ` +
    `Wait for a Mission Control delivery message with the reply.`
  );
}

export function sessionRef(session: Session | undefined): { handle?: string; sessionId?: string } {
  return session ? { handle: session.handle, sessionId: session.id } : {};
}
