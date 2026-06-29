import { describe, expect, test } from "bun:test";
import type { AgentTask } from "@mc/shared";
import { buildAskPrompt, buildReplyPrompt, canonicalHandle, parseAliasDirective, routedContext } from "./router.ts";

describe("router alias parsing", () => {
  test("canonicalizes mc:a handles", () => {
    expect(canonicalHandle("mc:a12")).toBe("mc:a12");
    expect(canonicalHandle("A7")).toBe("mc:a7");
    expect(canonicalHandle("-c1")).toBeNull();
  });

  test("parses ask/tell/ping directives", () => {
    expect(parseAliasDirective("ask mc:a3 what service x does")).toEqual({
      to: "mc:a3",
      text: "what service x does",
      verb: "ask",
    });
    expect(parseAliasDirective("tell a2 check the failing test")).toEqual({
      to: "mc:a2",
      text: "check the failing test",
      verb: "tell",
    });
    expect(parseAliasDirective("ping mc:a1")).toEqual({ to: "mc:a1", text: "ping", verb: "ping" });
  });

  test("parses direct handle-at-start prompts only", () => {
    expect(parseAliasDirective("mc:a4 summarize your current task")).toEqual({
      to: "mc:a4",
      text: "summarize your current task",
    });
    expect(parseAliasDirective("please ask mc:a4 later")).toBeNull();
  });

  test("terminal ask prompt prefers completion hooks over unavailable tools", () => {
    const task: AgentTask = {
      id: "mc-task-1",
      from: "mc:a9",
      fromSessionId: "host:9",
      to: "mc:a10",
      toSessionId: "host:10",
      text: "what the color?",
      state: "prompted",
      createdAt: 1,
      updatedAt: 1,
    };

    const prompt = buildAskPrompt(task);
    expect(prompt).toContain("Mission Control will route your final answer back automatically");
    expect(prompt).toContain("Do not try to contact mc:a9");
    expect(prompt).not.toContain("reply_to_agent");
    expect(prompt).not.toContain("get_agent_task");
  });

  test("reply prompt tells the source agent to consume the delivery", () => {
    const task: AgentTask = {
      id: "mc-task-1",
      from: "mc:a9",
      fromSessionId: "host:9",
      to: "mc:a10",
      toSessionId: "host:10",
      text: "what the color?",
      reply: "color = cyan",
      state: "replied",
      createdAt: 1,
      updatedAt: 2,
    };

    const prompt = buildReplyPrompt(task);
    expect(prompt).toContain("[Mission Control delivery mc-task-1]");
    expect(prompt).toContain("intercepted before it reached you");
    expect(prompt).toContain("<mission-control-reply>");
    expect(prompt).toContain("color = cyan");
    expect(prompt).toContain("may not appear in your prior conversation memory");
    expect(prompt).toContain("present it to the user concisely");
    expect(prompt).not.toContain("You previously routed");
    expect(prompt).not.toContain("Do not reroute it");
  });

  test("blocked source context waits for delivery without naming unavailable tools", () => {
    const task: AgentTask = {
      id: "mc-task-1",
      from: "mc:a9",
      fromSessionId: "host:9",
      to: "mc:a10",
      toSessionId: "host:10",
      text: "what the color?",
      state: "submitted",
      createdAt: 1,
      updatedAt: 1,
    };

    expect(routedContext(task)).toContain("Wait for a Mission Control delivery message");
    expect(routedContext(task)).not.toContain("get_agent_task");
  });
});
