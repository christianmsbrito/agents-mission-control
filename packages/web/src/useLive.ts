import { useEffect, useRef, useState } from "react";
import type { HostReport, LiveMsg, AppConfig, SpawnRequest } from "@mc/shared";

export type ConnState = "connecting" | "online" | "offline";

/** Subscribe to /ws/live and keep a hostId -> HostReport map in sync. */
export function useLive(url: string) {
  const [hosts, setHosts] = useState<Map<string, HostReport>>(new Map());
  const [conn, setConn] = useState<ConnState>("connecting");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => alive && setConn("online");
      ws.onmessage = (e) => {
        const msg: LiveMsg = JSON.parse(e.data);
        if (msg.type === "settings") { setConfig(msg.config); return; }
        setHosts((prev) => {
          const next = new Map(prev);
          if (msg.type === "state") {
            next.clear();
            for (const h of msg.hosts) next.set(h.hostId, h);
          } else if (msg.type === "patch") {
            next.set(msg.report.hostId, msg.report);
          } else if (msg.type === "offline") {
            next.delete(msg.hostId);
          }
          return next;
        });
      };
      ws.onclose = () => {
        if (!alive) return;
        setConn("offline");
        retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      alive = false;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [url]);

  const sendMsg = (msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const focus = (sessionId: string) => sendMsg({ type: "focus", sessionId });
  const kill = (sessionId: string) => sendMsg({ type: "kill", sessionId });
  const prompt = (sessionId: string, text: string) => sendMsg({ type: "prompt", sessionId, text });
  const setSettings = (patch: Partial<AppConfig>) => sendMsg({ type: "set-settings", patch });
  const spawn = (req: SpawnRequest) => sendMsg({ ...req, type: "spawn" });

  return { hosts, conn, config, focus, kill, prompt, setSettings, spawn };
}
