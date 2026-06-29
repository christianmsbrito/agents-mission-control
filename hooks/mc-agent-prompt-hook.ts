#!/usr/bin/env bun
/**
 * Generic Mission Control prompt hook adapter.
 *
 * Provider-specific hook systems can invoke this script with MC_AGENT_PROVIDER
 * set. The routing logic is intentionally server-side; this adapter only turns
 * a provider hook payload into `/api/intercept`.
 */

type Payload = Record<string, any>;

function emit(obj: object): void {
  process.stdout.write(JSON.stringify(obj));
}

function promptFrom(payload: Payload): string {
  for (const key of ["prompt", "user_prompt", "input", "text", "message"]) {
    if (typeof payload[key] === "string") return payload[key];
  }
  return "";
}

function providerFrom(payload: Payload): string {
  return (
    process.env.MC_AGENT_PROVIDER ||
    payload.provider ||
    payload.agent_provider ||
    payload.agent_type ||
    payload.agent_id ||
    ""
  ).toString();
}

function apiBase(): string {
  return (process.env.MC_API_URL || `http://localhost:${process.env.MC_PORT || 7777}`).replace(/\/+$/, "");
}

function token(): string {
  return process.env.MC_TOKEN || "dev-token";
}

function hookEvent(payload: Payload): string {
  return String(payload.hook_event_name || payload.hookEventName || "");
}

function lastAssistantMessageFrom(payload: Payload): string {
  for (const key of ["last_assistant_message", "lastAssistantMessage", "assistant_message", "response", "output"]) {
    if (typeof payload[key] === "string") return payload[key];
  }
  return "";
}

async function post(path: string, body: object): Promise<any> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
}

function shouldBlockAliasPrompt(): boolean {
  const mode = (process.env.MC_ALIAS_INTERCEPT_MODE || "block").toLowerCase();
  return mode !== "context" && mode !== "off" && mode !== "0";
}

async function main(): Promise<void> {
  const raw = await Bun.stdin.text();
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const provider = providerFrom(payload).trim();
  const event = hookEvent(payload) || "UserPromptSubmit";
  if (!provider) return;

  if (event === "Stop") {
    const text = lastAssistantMessageFrom(payload);
    if (!text.trim()) return;
    const body = await post("/api/complete", {
      provider,
      providerSessionId: payload.session_id || payload.sessionId || payload.providerSessionId,
      cwd: payload.cwd,
      text,
    });
    if (!body?.routed) return;
    emit({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: `Mission Control routed this answer back to ${body.task?.from ?? "the source agent"} as ${body.task?.id ?? "a task"}.`,
      },
    });
    return;
  }

  const prompt = promptFrom(payload);
  if (!prompt.trim()) return;

  const body = await post("/api/intercept", {
      provider,
      providerSessionId: payload.session_id || payload.sessionId || payload.providerSessionId,
      cwd: payload.cwd,
      prompt,
  });
  if (!body?.intercepted) return;

  const detail =
    body.context ||
    body.task?.error ||
    body.error ||
    `Mission Control intercepted this alias prompt${body.task?.id ? ` as ${body.task.id}` : ""}.`;
  const out: Record<string, any> = {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: detail,
    },
  };

  if (body.routed && body.ok !== false && shouldBlockAliasPrompt()) {
    out.decision = "block";
    out.reason = detail;
  }
  emit(out);
}

main().catch((err) => {
  emit({ systemMessage: `Mission Control prompt hook failed non-blocking: ${err instanceof Error ? err.message : err}` });
});
