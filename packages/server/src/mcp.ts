type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: any };

const BASE_URL = (process.env.MC_API_URL || `http://localhost:${process.env.MC_PORT || 7777}`).replace(/\/+$/, "");
const TOKEN = process.env.MC_TOKEN || "dev-token";
const PROTOCOL_VERSION = "2025-06-18";

function write(msg: object): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}

function result(id: JsonRpcId, value: unknown): void {
  write({ id, result: value });
}

function error(id: JsonRpcId, code: number, message: string): void {
  write({ id, error: { code, message } });
}

function toolResult(data: unknown, isError = false) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }], structuredContent: typeof data === "object" ? data : undefined, isError };
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

const tools = [
  {
    name: "list_agents",
    title: "List Mission Control Agents",
    description: "List live Mission Control agent handles such as mc:a1, including provider, host, cwd, and display name.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ask_agent",
    title: "Ask Agent",
    description:
      "Send a routed Mission Control question to another live agent handle. Include from when you know your own handle.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target handle, e.g. mc:a3." },
        text: { type: "string", description: "Question or instruction for the target agent." },
        from: { type: "string", description: "Optional source handle, e.g. mc:a1." },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "reply_to_agent",
    title: "Reply To Agent",
    description: "Reply to a Mission Control routed task. If the task has a source handle, the reply is routed back.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Mission Control task id, e.g. mc-task-1." },
        text: { type: "string", description: "Reply text." },
      },
      required: ["taskId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "get_agent_task",
    title: "Get Agent Task",
    description: "Fetch the current state of a Mission Control routed task.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string", description: "Mission Control task id." } },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
];

async function callTool(name: string, args: any) {
  if (name === "list_agents") return toolResult((await api("/api/agents")).agents);
  if (name === "ask_agent") {
    return toolResult(
      await api("/api/ask", { method: "POST", body: JSON.stringify({ to: args?.to, from: args?.from, text: args?.text }) }),
    );
  }
  if (name === "reply_to_agent") {
    return toolResult(
      await api("/api/reply", { method: "POST", body: JSON.stringify({ taskId: args?.taskId, text: args?.text }) }),
    );
  }
  if (name === "get_agent_task") return toolResult(await api(`/api/tasks/${encodeURIComponent(String(args?.taskId ?? ""))}`));
  return toolResult(`Unknown tool: ${name}`, true);
}

async function handle(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;
  const method = req.method ?? "";

  if (req.id === undefined && method.startsWith("notifications/")) return;

  try {
    if (method === "initialize") {
      result(id, {
        protocolVersion: req.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mission-control-router", title: "Mission Control Router", version: "0.1.0" },
        instructions:
          "Use list_agents to find mc:a<n> handles, ask_agent to route work, and reply_to_agent to answer routed tasks.",
      });
    } else if (method === "ping") {
      result(id, {});
    } else if (method === "tools/list") {
      result(id, { tools });
    } else if (method === "tools/call") {
      const out = await callTool(String(req.params?.name ?? ""), req.params?.arguments ?? {});
      result(id, out);
    } else {
      error(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    result(id, toolResult(err instanceof Error ? err.message : String(err), true));
  }
}

let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  while (true) {
    const idx = buffer.indexOf("\n");
    if (idx === -1) break;
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch (err) {
      error(null, -32700, err instanceof Error ? err.message : String(err));
    }
  }
}
