import type { SerializableCategoryConfig } from "./category.ts";

/** A single live agent session detected on a host. */
export type Session = {
  /** Stable key: `${hostId}:${pid}`. */
  id: string;
  provider: string;
  /** Provider-native session id when discoverable, e.g. Codex rollout UUID. */
  providerSessionId?: string;
  /** Server-assigned live routing handle, e.g. `mc:a1`. */
  handle?: string;
  /** Haiku-generated one-word label for scanability; not used for routing. */
  displayName?: string;
  pid: number;
  hostId: string;
  hostLabel: string;
  cwd: string | null;
  /** Role the agent is used for: "code" | "review" | "research" | "personal" | ... */
  category: string;
  /** Epoch ms the process started. */
  startedAt: number;
  /** CPU percent (point-in-time). */
  cpu: number;
  /** Resident memory, MB. */
  memMb: number;
  /** Epoch ms of last session-file write — fallback "processing" signal. */
  lastActivityAt?: number;
  /** Authoritative processing flag when the provider exposes one (e.g. claude status). */
  active?: boolean;
  /** This session's terminal tab is in the foreground of its terminal app. */
  focused?: boolean;
  /** Session is blocked waiting on the user (permission/approval/input prompt). */
  attention?: boolean;
  /** When attention: a short description of what the agent is waiting for. */
  ask?: string;
  /** When attention: a plausible suggested reply the user could send. */
  suggestion?: string;
  /** Most recent turn ended in an API/agent error (e.g. 500/overloaded). */
  errored?: boolean;
  /** The error looks transient/recoverable (infra blip) vs a hard/persistent failure. */
  errorTransient?: boolean;
  /** Epoch ms of the error — used to auto-expire transient errors. */
  errorAt?: number;
  /** Short human-readable description of the most recent crash (e.g. "API Error:
   * 500…"). Set only while {@link errored}; cleared in lockstep on recovery. */
  crashReason?: string;

  // --- best-effort enrichment (absent => render "—") ---
  model?: string;
  /** Broad subject of the session, anchored on the opening prompts. */
  subject?: string;
  /** Recent recap — what the session is doing now. */
  summary?: string;
  /** Fresh (non-cached) input tokens. */
  tokensIn?: number;
  /** Cache-read input tokens (billed ~0.1x of fresh input). */
  tokensCacheRead?: number;
  /** Cache-write/creation input tokens (billed ~1.25x of fresh input). */
  tokensCacheWrite?: number;
  tokensOut?: number;
  /** Live context-window occupancy entering the next turn (last turn's working
   * set), NOT the cumulative token total. Resets when the agent compacts. */
  contextTokens?: number;
  /** Model's max context window — the denominator for the occupancy gauge. */
  contextWindow?: number;
  toolsUsed?: string[];
  costUsd?: number;
  /** Current kanban work units, when the provider exposes a todo list. */
  workItems?: WorkItem[];
  /** The template that spawned this session, when launched via Mission Control. */
  templateId?: string;
};

/** A single kanban-style work unit ("Quest") within a session. Sourced passively
 * from provider todo lists (currently Claude/OpenClaw TodoWrite). */
export type WorkItem = {
  /** Stable per-session id: content hash (TodoWrite rewrites the whole list, no native id). */
  itemKey: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  /** TodoWrite "activeForm" (gerund phrasing shown while in progress). */
  activeForm?: string;
  /** Order within the list as last reported. */
  position?: number;
};

/** Quest lifecycle status. */
export type QuestStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** A user-managed quest ("task") — distinct from the passive TodoWrite-sourced
 * {@link WorkItem}. Created/assigned by the operator; owned by a lord (templateId)
 * and/or a live session (sessionKey). A lord-owned quest can exist before any
 * session is deployed, and is folded into the marching orders when one is. */
export type Quest = {
  id: string;
  subject: string;
  body?: string;
  status: QuestStatus;
  /** Assigned lord (spawn template). */
  templateId?: string;
  /** Attached session, once assigned to / deployed onto a live agent. */
  sessionKey?: string;
  createdAt: number;
  updatedAt: number;
};

/** A managed quest enriched with owner display context for the board. */
export type QuestView = Quest & {
  templateName?: string;
  provider?: string;        // lord's provider, or the session's provider
  sessionDisplayName?: string;
  sessionState?: PersistedSessionState;
  hostLabel?: string;
};

/** Server-side live alias for routing agent-to-agent prompts. */
export type AgentAlias = {
  handle: string;
  sessionId: string;
  generation: string;
  provider: string;
  providerSessionId?: string;
  hostId: string;
  hostLabel: string;
  pid: number;
  startedAt: number;
  cwd: string | null;
  subject?: string;
  summary?: string;
  displayName?: string;
};

export type AgentTaskState = "submitted" | "prompted" | "replied" | "failed";

/** A Mission Control routed message between two live agent handles. */
export type AgentTask = {
  id: string;
  from?: string;
  fromSessionId?: string;
  to: string;
  toSessionId: string;
  text: string;
  state: AgentTaskState;
  promptOk?: boolean;
  reply?: string;
  replyDelivered?: boolean;
  error?: string;
  createdAt: number;
  updatedAt: number;
  repliedAt?: number;
};

/** A live tmux window on a host — surfaced so the board can offer an
 * "into existing window" deploy target without the user knowing its id. */
export type TmuxWindow = { id: string; name: string; session: string; active?: boolean };

/** A live iTerm2 tab (its current session), surfaced as a deploy target for
 * iterm2-backed templates. `sessionId` is the iTerm session UUID to split into. */
export type ItermTab = { sessionId: string; title: string };

/** Snapshot of all sessions on one host at a moment. */
export type HostReport = {
  hostId: string;
  hostLabel: string;
  sentAt: number;
  sessions: Session[];
  /** Live tmux windows on this host (best-effort; absent/empty when tmux isn't running). */
  tmuxWindows?: TmuxWindow[];
  /** Live iTerm2 tabs on this host (macOS; absent/empty when iTerm isn't running). */
  itermTabs?: ItermTab[];
};

// --- Reporter -> Server messages ---
export type HelloMsg = {
  type: "hello";
  hostId: string;
  hostLabel: string;
  token: string;
};
export type ReportMsg = { type: "report"; report: HostReport };
export type PingMsg = { type: "ping" };
export type KilledMsg = { type: "killed"; pid: number; ok: boolean };
export type PromptedMsg = { type: "prompted"; pid: number; ok: boolean; commandId?: string };
// reporter → server spawn ack
export type SpawnedMsg = {
  type: "spawned"; ok: boolean; templateId: string;
  hostId?: string; windowId?: string; paneId?: string; pid?: number; error?: string; commandId?: string;
};
export type ReporterMsg = HelloMsg | ReportMsg | PingMsg | KilledMsg | PromptedMsg | SpawnedMsg;

// --- Server -> Reporter messages ---
export type FocusMsg = { type: "focus"; pid: number };
export type KillMsg = { type: "kill"; pid: number };
export type PromptMsg = { type: "prompt"; pid: number; text: string; commandId?: string };
export type ConfigMsg = { type: "config"; summaries: AppConfig["summaries"] };
// server → reporter spawn command
export type SpawnMsg = {
  type: "spawn"; commandId: string; templateId: string;
  cmd: string; args: string[]; prompt?: string; cwd?: string | null; windowId?: string; name?: string;
  /** Pane backend: "iterm2" (native panes) or "tmux". Defaults to iterm2. */
  backend?: "iterm2" | "tmux";
};
export type ServerToReporterMsg = FocusMsg | KillMsg | PromptMsg | ConfigMsg | SpawnMsg;

// --- Browser -> Server messages ---
export type FocusRequest = { type: "focus"; sessionId: string };
export type KillRequest = { type: "kill"; sessionId: string };
export type PromptRequest = { type: "prompt"; sessionId: string; text: string };
export type SetSettingsRequest = { type: "set-settings"; patch: Partial<AppConfig> };
// browser → server spawn request
export type SpawnRequest = {
  type: "spawn"; hostId: string; templateId: string;
  windowId?: string; cwd?: string; promptOverride?: string;
  /** Managed quests to fold into the marching orders + mark in_progress on deploy. */
  questIds?: string[];
};
export type WebToServerMsg = FocusRequest | KillRequest | PromptRequest | SetSettingsRequest | SpawnRequest;

/**
 * Lifecycle events published by the server for downstream consumers (live on
 * /ws/events and appended to events.jsonl). A union so more event types can be
 * added later (session.started, session.errored, …).
 */
type BaseEvent = {
  at: number;
  sessionId: string;
  hostId: string;
  pid: number;
  ok: boolean;
  provider?: string;
  cwd?: string | null;
  subject?: string;
};
export type SessionKilledEvent = BaseEvent & { type: "session.killed" };
export type SessionPromptedEvent = BaseEvent & { type: "session.prompted"; text: string };
export type SessionSpawnedEvent = BaseEvent & { type: "session.spawned"; templateId: string; windowId?: string; paneId?: string };
/** A deployed troop (a session spawned from a template) ended. Carries the
 * lineage + the troop's final rollup so a consumer can report back to the
 * template / update a vault / etc. Only emitted for sessions with a templateId. */
export type TroopClosedEvent = BaseEvent & {
  type: "troop.closed";
  templateId: string;
  summary?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** ms the troop was alive (now - startedAt). */
  durationMs?: number;
};
/** A new agent session was first seen. `templateId` set ⇒ a troop's process has
 * actually launched (vs `session.spawned` = deploy command issued). */
export type SessionStartedEvent = BaseEvent & { type: "session.started"; templateId?: string };
/** A session's turn hit an API/agent error. `templateId` set ⇒ a troop errored. */
export type SessionErroredEvent = BaseEvent & { type: "session.errored"; templateId?: string; transient?: boolean };
/** A session flipped to blocked-waiting-on-user (the amber "needs input" flag). */
export type SessionAttentionEvent = BaseEvent & { type: "session.attention"; templateId?: string; ask?: string; suggestion?: string };
/** A tracked work item ("quest") flipped to completed. */
export type QuestCompletedEvent = BaseEvent & { type: "quest.completed"; templateId?: string; itemKey: string; questSubject?: string };
/** A session's cumulative cost crossed the configured budget threshold (once). */
export type BudgetExceededEvent = BaseEvent & { type: "budget.exceeded"; templateId?: string; costUsd: number; thresholdUsd: number };
/** A troop went idle (no activity) past the configured threshold (once). */
export type TroopIdleEvent = BaseEvent & { type: "troop.idle"; templateId: string; idleMs: number };
export type SessionEvent =
  | SessionKilledEvent | SessionPromptedEvent | SessionSpawnedEvent | TroopClosedEvent
  | SessionStartedEvent | SessionErroredEvent | SessionAttentionEvent | QuestCompletedEvent
  | BudgetExceededEvent | TroopIdleEvent;

/** A reporter/host connected or went away. Not session-scoped. */
export type HostEvent = { type: "host.online" | "host.offline"; at: number; hostId: string; hostLabel?: string };
/** A template was created / edited / deleted. Not session-scoped. */
export type TemplateEvent = { type: "template.created" | "template.updated" | "template.deleted"; at: number; templateId: string; name?: string };
/** A template's derived level crossed a boundary (XP from its troops). */
export type TemplateLeveledUpEvent = { type: "template.leveled_up"; at: number; templateId: string; name?: string; level: number; prevLevel: number };

/** Everything publishable on /ws/events + events.jsonl. */
export type PublishedEvent = SessionEvent | HostEvent | TemplateEvent | TemplateLeveledUpEvent;

// --- Server -> Web messages ---
export type StateMsg = { type: "state"; hosts: HostReport[] };
export type PatchMsg = { type: "patch"; report: HostReport };
export type OfflineMsg = { type: "offline"; hostId: string };
export type SettingsMsg = { type: "settings"; config: AppConfig };
export type LiveMsg = StateMsg | PatchMsg | OfflineMsg | SettingsMsg;

/** Server-held, persisted runtime configuration of the whole board. */
export type AppConfig = {
  /** Drop a host as offline after this many ms of silence. */
  staleMs: number;
  /** Role mapping, re-resolved server-side on every ingest. */
  categories: SerializableCategoryConfig;
  /** Reporter-side LLM recap settings, pushed to reporters. */
  summaries: { enabled: boolean; model: string; minIntervalMs: number };
  /** Persistence retention policy. */
  retention: RetentionConfig;
  /** Emit a `budget.exceeded` event when a session's cost crosses this many USD.
   * 0/undefined disables the check. */
  budgetUsd?: number;
  /** Emit a `troop.idle` event when a troop is inactive this many minutes.
   * 0/undefined disables the check. */
  idleMinutes?: number;
};

// --- Persistence layer ---

/** Lifecycle state of a persisted session in the registry. */
export type PersistedSessionState = "running" | "closed" | "orphaned";

/** A registry row: one per session, kept forever. */
export type PersistedSession = {
  sessionKey: string;          // providerSessionId, else `${hostId}:${pid}:${startedAt}`
  liveId: string;              // last `${hostId}:${pid}`
  resumeId?: string;           // provider-native id a CLI resumes with
  provider: string;
  hostId: string;
  hostLabel: string;
  cwd: string | null;
  category: string;
  model?: string;
  handle?: string;             // A2A routing tag, e.g. "mc:a3"
  displayName?: string;        // Haiku nickname
  subject?: string;
  startedAt: number;
  endedAt?: number;
  state: PersistedSessionState;
  lastSeenAt: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  peakContextTokens?: number;
  toolsUsed?: string[];
  summary?: string;
  attention?: boolean;
  ask?: string;
  suggestion?: string;
};

/** A time-series sample row. */
export type SessionSample = {
  sessionKey: string;
  at: number;
  resolution: "raw" | "hour" | "day";
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  costUsd?: number;
  contextTokens?: number;
  contextWindow?: number;
  cpu?: number;
  memMb?: number;
  active?: number;             // 0/1 raw; duty-cycle fraction once condensed
};

/** One point in a rollup series. */
export type TimeseriesPoint = { t: number; value: number };
/** A named rollup series (key is "" for groupBy=none). */
export type TimeseriesSeries = { key: string; points: TimeseriesPoint[] };
/** Response of GET /api/stats/timeseries. */
export type TimeseriesResponse = {
  bucket: "hour" | "day";
  metric: "cost" | "tokens";
  series: TimeseriesSeries[];
};

/** Discrete event types persisted to the events table. Superset of the live
 * `SessionEvent` `type` discriminants, plus persistence-only event types. */
export type PersistedEventType =
  | "session.started"
  | "session.closed"
  | "session.state"
  | "session.tool"
  | "session.errored"
  | "session.killed"
  | "session.prompted"
  | "session.spawned"
  | "session.attention"
  | "troop.closed"
  | "troop.idle"
  | "quest.completed"
  | "budget.exceeded"
  | "host.online"
  | "host.offline"
  | "template.created"
  | "template.updated"
  | "template.deleted"
  | "template.leveled_up"
  | "task.routed"
  | "task.replied";

export type PersistedEvent = {
  at: number;
  sessionKey: string;
  type: PersistedEventType;
  hostId?: string;
  pid?: number;
  detail?: Record<string, unknown>;
};

/** Retention policy — all editable in the Settings panel. */
export type RetentionConfig = {
  sampleIntervalMs: number;    // gate between raw samples per session
  rawDays: number;             // keep raw resolution this long (default 15)
  hourDays: number;            // keep hourly resolution this long (default 90)
  eventDays: number;           // hard-delete events older than this (default 90)
  maxBytes: number;            // size ceiling; preempts age ladder (default ~500MB)
  compactIntervalMs: number;   // min gap between compaction runs (default ~1h)
  orphanCloseDays: number;     // after this many days, a still-orphaned session is reconciled to closed (default 7)
};

const RESUME_TEMPLATES: Record<string, (id: string, cwd: string | null) => string> = {
  claude: (id, cwd) => prefixCwd(cwd, `claude --resume ${id}`),
  codex: (id, cwd) => prefixCwd(cwd, `codex resume ${id}`),
  opencode: (id, cwd) => prefixCwd(cwd, `opencode --session ${id}`), // VERIFY flag
  pi: (id, cwd) => prefixCwd(cwd, `pi --resume ${id}`),               // VERIFY flag
  hermes: (id) => `hermes --resume ${id}`,                            // global daemon: no cwd, no cd prefix
};

function prefixCwd(cwd: string | null, cmd: string): string {
  if (!cwd) return cmd;
  // Single-quote the cwd so paths with spaces survive shell paste; escape any
  // embedded single quote with the '\'' idiom.
  const quoted = `'${cwd.replace(/'/g, "'\\''")}'`;
  return `cd ${quoted} && ${cmd}`;
}

/** Build a provider-specific resume command, or null when there is no resume id. */
export function resumeCommand(s: { provider: string; resumeId?: string; cwd: string | null }): string | null {
  if (!s.resumeId) return null;
  const tmpl = RESUME_TEMPLATES[s.provider];
  return tmpl ? tmpl(s.resumeId, s.cwd) : s.resumeId;
}
