import { Database } from "bun:sqlite";
import { templateLevel, DEFAULT_BACKEND } from "@mc/shared";
import type {
  HostReport,
  TemplateWithXp,
  SpawnBackend,
  PersistedEvent,
  PersistedEventType,
  PersistedSession,
  PersistedSessionState,
  PersistedSubSession,
  RetentionConfig,
  Session,
  SessionSample,
  TimeseriesResponse,
  TimeseriesSeries,
  WorkItem,
  Quest,
  QuestStatus,
  QuestView,
} from "@mc/shared";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Filter for the session registry list/count queries. */
export type SessionFilter = {
  state?: PersistedSessionState;
  provider?: string;
  category?: string;
  cwd?: string;
  host?: string; // host_id
  since?: number; // started_at >=
  until?: number; // started_at <=
  /** Keep only sessions with >= this many total tokens (running sessions exempt). */
  minTokens?: number;
  /** Free-text search: whitespace-split terms ANDed, each matched (LIKE) across
   * display_name/subject/summary/cwd/handle/provider/model. */
  q?: string;
  sort?: SessionSort;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

export type SessionSort = "lastSeen" | "started" | "cost" | "tokens" | "context";

const SESSION_SORT_COLUMNS: Record<SessionSort, string> = {
  lastSeen: "last_seen_at",
  started: "started_at",
  cost: "cost_usd",
  tokens: "(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)+COALESCE(tokens_cache_read,0)+COALESCE(tokens_cache_write,0))",
  context: "peak_context_tokens",
};

/** Filter for the cross-session quest board. */
export type QuestFilter = {
  status?: "pending" | "in_progress" | "completed";
  provider?: string;
  category?: string;
  sessionState?: PersistedSessionState;
  limit?: number;
};

/** A work item enriched with its session's identity, for the cross-session board. */
export type QuestRow = WorkItem & {
  sessionKey: string;
  provider: string;
  category: string;
  displayName?: string;
  hostLabel: string;
  sessionState: PersistedSessionState;
  updatedAt: number;
};

export type FacetBucket = { value: string; count: number; label?: string };
export type Facets = {
  providers: FacetBucket[];
  categories: FacetBucket[];
  hosts: FacetBucket[];
  states: FacetBucket[];
};

/** Floor a timestamp to the start of its UTC hour (ms). Pure. */
export function hourBucket(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** Floor a timestamp to the start of its UTC day (ms). Pure. */
export function dayBucket(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** A condensed sample: the downsampled representation of many finer samples
 * within a single (session_key, bucket). */
export type CondensedSample = {
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  context_tokens: number | null;
  context_window: number | null;
  cpu: number | null;
  mem_mb: number | null;
  active: number;
};

/** Shape of a sample row as condensing cares about it. */
type Sampleish = {
  at: number;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  context_tokens: number | null;
  context_window: number | null;
  cpu: number | null;
  mem_mb: number | null;
  active: number | null;
};

/** Condense many finer samples (all in ONE (session_key, bucket)) into one row:
 * - cumulative fields (cost, token counters) take the LAST (max `at`) value;
 * - gauges (context_tokens, cpu, mem_mb) are averaged (ignoring nulls);
 * - context_window takes the last value;
 * - active is the fraction of rows where active>0 (0..1).
 * Pure — no DB access. */
export function condenseSamples(rows: Sampleish[]): CondensedSample {
  const last = rows.reduce((a, b) => (b.at >= a.at ? b : a));
  const avg = (pick: (r: Sampleish) => number | null): number | null => {
    let sum = 0;
    let n = 0;
    for (const r of rows) {
      const v = pick(r);
      if (v != null) {
        sum += v;
        n += 1;
      }
    }
    return n === 0 ? null : sum / n;
  };
  const activeCount = rows.filter((r) => (r.active ?? 0) > 0).length;
  return {
    cost_usd: last.cost_usd,
    tokens_in: last.tokens_in,
    tokens_out: last.tokens_out,
    tokens_cache_read: last.tokens_cache_read,
    tokens_cache_write: last.tokens_cache_write,
    context_tokens: avg((r) => r.context_tokens),
    context_window: last.context_window,
    cpu: avg((r) => r.cpu),
    mem_mb: avg((r) => r.mem_mb),
    active: rows.length === 0 ? 0 : activeCount / rows.length,
  };
}

const DEFAULT_RETENTION: RetentionConfig = {
  sampleIntervalMs: 60_000,
  rawDays: 15,
  hourDays: 90,
  eventDays: 90,
  maxBytes: 500_000_000,
  compactIntervalMs: 3_600_000,
  orphanCloseDays: 7,
};

/** Derive the stable persistence key for a session: provider-native id when
 * present, else a synthetic `${hostId}:${pid}:${floor(startedAt/1000)}`.
 *
 * The synthetic start is floored to whole SECONDS (only in the key — the stored
 * `started_at` keeps full ms). Reporter `startedAt = now - uptimeSec*1000` jitters
 * up to ±999ms per tick (uptimeSec is `ps` etime floored to whole seconds while
 * `now` advances continuously), so flooring to the second collapses every jittered
 * variant of one daemon session to ONE key instead of re-inserting a new row each
 * tick. host+pid still disambiguate genuinely-distinct sessions within that second. */
export function sessionKeyOf(s: Session): string {
  return s.providerSessionId || `${s.hostId}:${s.pid}:${Math.floor(s.startedAt / 1000)}`;
}

/** Columns derived from a live Session for a registry upsert. Centralizes the
 * `id`->`live_id` / `providerSessionId`->`resume_id` naming translations so they
 * live in exactly one place. */
type SessionRow = {
  session_key: string;
  live_id: string;
  resume_id: string | null;
  provider: string;
  host_id: string;
  host_label: string;
  cwd: string | null;
  category: string;
  model: string | null;
  handle: string | null;
  display_name: string | null;
  subject: string | null;
  started_at: number;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
};

function sessionToRow(s: Session): SessionRow {
  return {
    session_key: sessionKeyOf(s),
    live_id: s.id,
    resume_id: s.providerSessionId ?? null,
    provider: s.provider,
    host_id: s.hostId,
    host_label: s.hostLabel,
    cwd: s.cwd,
    category: s.category,
    model: s.model ?? null,
    handle: s.handle ?? null,
    display_name: s.displayName ?? null,
    subject: s.subject ?? null,
    started_at: s.startedAt,
    cost_usd: s.costUsd ?? null,
    tokens_in: s.tokensIn ?? null,
    tokens_out: s.tokensOut ?? null,
    tokens_cache_read: s.tokensCacheRead ?? null,
    tokens_cache_write: s.tokensCacheWrite ?? null,
  };
}

/** Detail payload for an events-table row. */
type EventDetail = Record<string, unknown> | null;

/** What `record()` detected this tick by diffing against the prior report, so the
 * server edge can publish live lifecycle events without re-deriving the diff.
 * Arrays carry the *current* Session for each change (the prior one for `closed`). */
export type RecordDiff = {
  started: Session[];
  closed: Session[];
  errored: Session[];
  attention: Session[];
  questsCompleted: { session: Session; item: WorkItem }[];
};

/** Owns the bun:sqlite handle and all persistence reads/writes. */
export class Store {
  readonly db: Database;
  /** Last-tick snapshot per host: hostId -> (sessionKey -> Session). Used to
   * diff successive reports into lifecycle events. */
  private prevByHost = new Map<string, Map<string, Session>>();
  /** Per-session last raw-sample time (sessionKey -> ms). Gates sampling. */
  private lastSampleAt = new Map<string, number>();
  private sampleIntervalMs: number;
  /** CPU-percent floor above which a tick counts as "active" for activeMs
   * accumulation (a tick also counts when `session.active` is set). From env
   * `MC_ACTIVE_CPU_PCT`, default 1 — any measurable CPU (see design doc). */
  private readonly activeCpuThreshold: number;
  /** Full retention policy (age ladder + size ceiling + compaction cadence).
   * Mutable so the live store can adopt Settings-panel edits via setRetention. */
  private retention: RetentionConfig;
  /** Last time compact() actually ran; 0 so the first maybeCompact runs. */
  private lastCompactAt = 0;
  /** Prepared statements, hoisted out of the per-session loop. */
  private readonly selExisting;
  private readonly selHas;
  private readonly upsertSession;
  private readonly insEvent;
  private readonly insSample;
  private readonly markClosed;
  private readonly orphanHost;
  private readonly closeStaleOrphans;
  private readonly applyEnrich;
  private readonly upsertWorkItem;
  private readonly upsertSubSession;
  private readonly accrueActiveMs;
  /**
   * Backward-compatible constructor. `opts.sampleIntervalMs` (legacy) still works
   * and, if given, overrides `opts.retention.sampleIntervalMs`. Anything omitted
   * falls back to {@link DEFAULT_RETENTION}, so `new Store(":memory:")` works.
   */
  constructor(
    path: string,
    opts?: { sampleIntervalMs?: number; retention?: Partial<RetentionConfig> },
  ) {
    this.retention = { ...DEFAULT_RETENTION, ...(opts?.retention ?? {}) };
    if (opts?.sampleIntervalMs != null) this.retention.sampleIntervalMs = opts.sampleIntervalMs;
    this.sampleIntervalMs = this.retention.sampleIntervalMs;
    this.activeCpuThreshold = Number(process.env.MC_ACTIVE_CPU_PCT ?? 1) || 0;
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
    this.selExisting = this.db.query(
      "SELECT peak_context_tokens, tools_used FROM sessions WHERE session_key = ?",
    );
    this.selHas = this.db.query("SELECT 1 FROM sessions WHERE session_key = ? LIMIT 1");
    this.upsertSession = this.db.query(
      `INSERT INTO sessions (
         session_key, live_id, resume_id, provider, host_id, host_label, cwd,
         category, model, handle, display_name, subject,
         started_at, ended_at, state, last_seen_at,
         cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write,
         peak_context_tokens, tools_used,
         summary, attention, ask, suggestion, template_id
       ) VALUES (
         $session_key, $live_id, $resume_id, $provider, $host_id, $host_label, $cwd,
         $category, $model, $handle, $display_name, $subject,
         $started_at, NULL, 'running', $last_seen_at,
         $cost_usd, $tokens_in, $tokens_out, $tokens_cache_read, $tokens_cache_write,
         $peak_context_tokens, $tools_used,
         $summary, $attention, $ask, $suggestion, $template_id
       )
       ON CONFLICT(session_key) DO UPDATE SET
         state = 'running',
         last_seen_at = excluded.last_seen_at,
         live_id = excluded.live_id,
         handle = excluded.handle,
         display_name = excluded.display_name,
         subject = excluded.subject,
         model = excluded.model,
         category = excluded.category,
         provider = excluded.provider,
         host_id = excluded.host_id,
         host_label = excluded.host_label,
         cwd = excluded.cwd,
         resume_id = excluded.resume_id,
         cost_usd = excluded.cost_usd,
         tokens_in = excluded.tokens_in,
         tokens_out = excluded.tokens_out,
         tokens_cache_read = excluded.tokens_cache_read,
         tokens_cache_write = excluded.tokens_cache_write,
         peak_context_tokens = excluded.peak_context_tokens,
         tools_used = excluded.tools_used,
         summary = excluded.summary,
         attention = excluded.attention,
         ask = excluded.ask,
         suggestion = excluded.suggestion,
         template_id = COALESCE(excluded.template_id, template_id)`,
    );
    this.insEvent = this.db.query(
      `INSERT INTO events (at, session_key, type, host_id, pid, detail)
       VALUES ($at, $session_key, $type, $host_id, $pid, $detail)`,
    );
    // Generalized over `resolution` (live path passes 'raw'; importSession passes
    // the historical row's own resolution). INSERT OR IGNORE so re-running an
    // import is idempotent on the (session_key, at, resolution) PK.
    this.insSample = this.db.query(
      `INSERT OR IGNORE INTO samples (
         session_key, at, resolution,
         tokens_in, tokens_out, tokens_cache_read, tokens_cache_write,
         cost_usd, context_tokens, context_window, cpu, mem_mb, active
       ) VALUES (
         $session_key, $at, $resolution,
         $tokens_in, $tokens_out, $tokens_cache_read, $tokens_cache_write,
         $cost_usd, $context_tokens, $context_window, $cpu, $mem_mb, $active
       )`,
    );
    this.markClosed = this.db.query(
      "UPDATE sessions SET state = 'closed', ended_at = $ended_at WHERE session_key = $session_key",
    );
    this.orphanHost = this.db.query(
      "UPDATE sessions SET state = 'orphaned', last_seen_at = ? WHERE host_id = ? AND state = 'running'",
    );
    // Reconcile sessions stuck 'orphaned' past the orphan window: the host never
    // came back, so treat them as dead. ended_at = last_seen_at (best estimate of
    // when the process actually died — the last time we saw it alive).
    this.closeStaleOrphans = this.db.query(
      "UPDATE sessions SET state = 'closed', ended_at = last_seen_at WHERE state = 'orphaned' AND last_seen_at < ?",
    );
    // Backfill enrichment write-back: set the model-derived recap fields. subject
    // uses COALESCE so a null/absent model subject keeps the existing heuristic one.
    this.applyEnrich = this.db.query(
      `UPDATE sessions SET summary = $summary, attention = $attention, ask = $ask,
         suggestion = $suggestion, subject = COALESCE($subject, subject)
       WHERE session_key = $session_key`,
    );
    this.upsertWorkItem = this.db.query(
      `INSERT INTO work_items (session_key, item_key, subject, status, active_form, position, created_at, updated_at)
       VALUES ($session_key, $item_key, $subject, $status, $active_form, $position, $now, $now)
       ON CONFLICT(session_key, item_key) DO UPDATE SET
         subject = excluded.subject, status = excluded.status,
         active_form = excluded.active_form, position = excluded.position,
         updated_at = excluded.updated_at`,
    );
    // Subagent breakdown, keyed to its parent. Latest snapshot wins (a subagent's
    // transcript totals are monotonic within the parent), mirroring work_items.
    this.upsertSubSession = this.db.query(
      `INSERT INTO sub_sessions (
         session_key, agent_id, kind, tokens_in, tokens_out, tokens_cache_read,
         tokens_cache_write, cost_usd, model, peak_context_tokens, tools_used, first_at, last_at
       ) VALUES (
         $session_key, $agent_id, $kind, $tokens_in, $tokens_out, $tokens_cache_read,
         $tokens_cache_write, $cost_usd, $model, $peak_context_tokens, $tools_used, $first_at, $last_at
       )
       ON CONFLICT(session_key, agent_id) DO UPDATE SET
         kind = excluded.kind, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
         tokens_cache_read = excluded.tokens_cache_read, tokens_cache_write = excluded.tokens_cache_write,
         cost_usd = excluded.cost_usd, model = excluded.model,
         peak_context_tokens = excluded.peak_context_tokens, tools_used = excluded.tools_used,
         first_at = excluded.first_at, last_at = excluded.last_at`,
    );
    // Accrue one sampled interval onto a session's activeMs. Downsample-proof:
    // the accumulator lives on the row, not derived from (lossy) condensed samples.
    this.accrueActiveMs = this.db.query(
      "UPDATE sessions SET active_ms = COALESCE(active_ms, 0) + $delta WHERE session_key = $session_key",
    );
  }
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY, live_id TEXT, resume_id TEXT,
        provider TEXT, host_id TEXT, host_label TEXT, cwd TEXT,
        category TEXT, model TEXT, handle TEXT, display_name TEXT, subject TEXT,
        started_at INTEGER, ended_at INTEGER, state TEXT, last_seen_at INTEGER,
        cost_usd REAL, tokens_in INTEGER, tokens_out INTEGER,
        tokens_cache_read INTEGER, tokens_cache_write INTEGER,
        peak_context_tokens INTEGER, tools_used TEXT,
        summary TEXT, attention INTEGER, ask TEXT, suggestion TEXT,
        template_id TEXT
      );
      CREATE TABLE IF NOT EXISTS samples (
        session_key TEXT, at INTEGER, resolution TEXT,
        tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER,
        tokens_cache_write INTEGER, cost_usd REAL, context_tokens INTEGER,
        context_window INTEGER, cpu REAL, mem_mb REAL, active REAL,
        PRIMARY KEY (session_key, at, resolution)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, session_key TEXT,
        type TEXT, host_id TEXT, pid INTEGER, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_samples_key_at ON samples(session_key, at);
      CREATE INDEX IF NOT EXISTS ix_events_at ON events(at);
      CREATE INDEX IF NOT EXISTS ix_events_key ON events(session_key);
      CREATE INDEX IF NOT EXISTS ix_sessions_state ON sessions(state);
      CREATE INDEX IF NOT EXISTS ix_sessions_provider ON sessions(provider);
      CREATE INDEX IF NOT EXISTS ix_sessions_started ON sessions(started_at);
      CREATE TABLE IF NOT EXISTS work_items (
        session_key TEXT NOT NULL, item_key TEXT NOT NULL,
        subject TEXT NOT NULL, status TEXT NOT NULL, active_form TEXT,
        position INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_key, item_key)
      );
      CREATE INDEX IF NOT EXISTS ix_work_items_key ON work_items(session_key);
      CREATE INDEX IF NOT EXISTS ix_work_items_status ON work_items(status);
      CREATE TABLE IF NOT EXISTS sub_sessions (
        session_key TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT,
        tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER,
        tokens_cache_write INTEGER, cost_usd REAL, model TEXT,
        peak_context_tokens INTEGER, tools_used TEXT, first_at INTEGER, last_at INTEGER,
        PRIMARY KEY (session_key, agent_id)
      );
      CREATE INDEX IF NOT EXISTS ix_sub_sessions_key ON sub_sessions(session_key);
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL,
        args_json TEXT, prompt TEXT, cwd TEXT, rpg_json TEXT, backend TEXT,
        created_at INTEGER NOT NULL, archived_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS quests (
        id TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT,
        status TEXT NOT NULL, template_id TEXT, session_key TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_quests_template ON quests(template_id);
      CREATE INDEX IF NOT EXISTS ix_quests_session ON quests(session_key);
      CREATE INDEX IF NOT EXISTS ix_quests_status ON quests(status);
    `);
    // Guarded ALTERs for pre-existing DBs created before the enrichment columns.
    for (const col of ["summary TEXT", "attention INTEGER", "ask TEXT", "suggestion TEXT", "template_id TEXT", "active_ms INTEGER"]) {
      try { this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch { /* already present */ }
    }
    try { this.db.exec("ALTER TABLE templates ADD COLUMN backend TEXT"); } catch { /* already present */ }
    // Index template_id AFTER the guarded ALTER above — on a pre-existing DB the
    // column doesn't exist until the ALTER runs, so indexing it inline in the
    // CREATE block above would fail with "no such column: template_id".
    this.db.exec("CREATE INDEX IF NOT EXISTS ix_sessions_template ON sessions(template_id);");
  }
  /** Append one event row. Part of the surrounding transaction. */
  private insertEvent(e: {
    at: number;
    sessionKey: string;
    type: PersistedEventType;
    hostId?: string;
    pid?: number;
    detail?: EventDetail;
  }): void {
    this.insEvent.run({
      $at: e.at,
      $session_key: e.sessionKey,
      $type: e.type,
      $host_id: e.hostId ?? null,
      $pid: e.pid ?? null,
      $detail: e.detail != null ? JSON.stringify(e.detail) : null,
    });
  }

  /** Append one event row outside the report-ingest diff path (e.g. kill/prompt
   * lifecycle events relayed through the server edge). Public, single-row insert
   * via the shared prepared statement. */
  event(e: PersistedEvent): void {
    this.insertEvent({
      at: e.at,
      sessionKey: e.sessionKey,
      type: e.type,
      hostId: e.hostId,
      pid: e.pid,
      detail: e.detail ?? null,
    });
  }

  /** True iff a registry row already exists for this session_key. */
  has(sessionKey: string): boolean {
    return !!this.selHas.get(sessionKey);
  }

  /** Import a historical session (registry row + its samples + events) discovered
   * by the backfill orchestrator. Skip-if-exists: a live row for the same key
   * always wins, so an already-present session_key is left untouched and we return
   * "skipped". Otherwise we INSERT the registry row (state/ended_at from the
   * PersistedSession, not forced 'running'), its samples (INSERT OR IGNORE so
   * re-runs are idempotent on the (key,at,resolution) PK), and its events (via the
   * shared insEvent path). All in one transaction. */
  importSession(
    session: PersistedSession,
    samples: SessionSample[] = [],
    events: PersistedEvent[] = [],
  ): "imported" | "skipped" {
    let result: "imported" | "skipped" = "imported";
    this.db.transaction(() => {
      if (this.has(session.sessionKey)) {
        result = "skipped";
        return;
      }
      // Parallels sessionToRow/upsertSession (camelCase->snake_case). The three
      // session column lists — the CREATE TABLE, upsertSession, and this INSERT —
      // must stay in sync when the schema grows.
      this.db.query(
        `INSERT INTO sessions (
           session_key, live_id, resume_id, provider, host_id, host_label, cwd,
           category, model, handle, display_name, subject,
           started_at, ended_at, state, last_seen_at,
           cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write,
           peak_context_tokens, tools_used,
           summary, attention, ask, suggestion, template_id
         ) VALUES (
           $session_key, $live_id, $resume_id, $provider, $host_id, $host_label, $cwd,
           $category, $model, $handle, $display_name, $subject,
           $started_at, $ended_at, $state, $last_seen_at,
           $cost_usd, $tokens_in, $tokens_out, $tokens_cache_read, $tokens_cache_write,
           $peak_context_tokens, $tools_used,
           $summary, $attention, $ask, $suggestion, $template_id
         )`,
      ).run({
        $session_key: session.sessionKey,
        $live_id: session.liveId,
        $resume_id: session.resumeId ?? null,
        $provider: session.provider,
        $host_id: session.hostId,
        $host_label: session.hostLabel,
        $cwd: session.cwd,
        $category: session.category,
        $model: session.model ?? null,
        $handle: session.handle ?? null,
        $display_name: session.displayName ?? null,
        $subject: session.subject ?? null,
        $started_at: session.startedAt,
        $ended_at: session.endedAt ?? null,
        $state: session.state,
        $last_seen_at: session.lastSeenAt,
        $cost_usd: session.costUsd ?? null,
        $tokens_in: session.tokensIn ?? null,
        $tokens_out: session.tokensOut ?? null,
        $tokens_cache_read: session.tokensCacheRead ?? null,
        $tokens_cache_write: session.tokensCacheWrite ?? null,
        $peak_context_tokens: session.peakContextTokens ?? null,
        $tools_used: session.toolsUsed ? JSON.stringify(session.toolsUsed) : null,
        $summary: session.summary ?? null,
        $attention: session.attention ? 1 : 0,
        $ask: session.ask ?? null,
        $suggestion: session.suggestion ?? null,
        $template_id: null,
      });
      for (const sm of samples) {
        this.insSample.run({
          $session_key: sm.sessionKey,
          $at: sm.at,
          $resolution: sm.resolution,
          $tokens_in: sm.tokensIn ?? null,
          $tokens_out: sm.tokensOut ?? null,
          $tokens_cache_read: sm.tokensCacheRead ?? null,
          $tokens_cache_write: sm.tokensCacheWrite ?? null,
          $cost_usd: sm.costUsd ?? null,
          $context_tokens: sm.contextTokens ?? null,
          $context_window: sm.contextWindow ?? null,
          $cpu: sm.cpu ?? null,
          $mem_mb: sm.memMb ?? null,
          $active: sm.active ?? null,
        });
      }
      for (const e of events) this.event(e);
    })();
    return result;
  }

  /** Write back model-derived enrichment for one (already-imported) session.
   * `subject` is COALESCEd so an absent model subject keeps the heuristic one;
   * `attention` maps bool->1/0; summary/ask/suggestion set to the value or null.
   * NOTE: `attention` is an authoritative OVERWRITE (undefined -> 0), not a merge —
   * a future caller patching only `summary` would clear it. Always pass the full set. */
  applyEnrichment(
    sessionKey: string,
    fields: { subject?: string; summary?: string; attention?: boolean; ask?: string; suggestion?: string },
  ): void {
    this.applyEnrich.run({
      $session_key: sessionKey,
      $summary: fields.summary ?? null,
      $attention: fields.attention ? 1 : 0,
      $ask: fields.ask ?? null,
      $suggestion: fields.suggestion ?? null,
      $subject: fields.subject ?? null,
    });
  }

  /** Registry rows still missing an LLM recap (summary IS NULL), with their
   * current (heuristic) subject. Drives the backfill enrichment phase.
   * Filtered to `state = 'closed'` so the authoritative enrich overwrite of
   * attention/summary can never touch a LIVE (running) or orphaned row — live
   * data always wins; only backfilled/closed rows are ever enriched. */
  sessionsMissingEnrichment(): { sessionKey: string; subject?: string }[] {
    const rows = this.db
      .query("SELECT session_key, subject FROM sessions WHERE summary IS NULL AND state = 'closed'")
      .all() as any[];
    return rows.map((r) => ({ sessionKey: r.session_key, subject: r.subject ?? undefined }));
  }

  /** The retention policy currently in use by this store. */
  get retentionConfig(): RetentionConfig {
    return this.retention;
  }

  /** Adopt a (partial) retention config edited at runtime (Settings panel),
   * merging it over the current config with the same precedence the constructor
   * uses, and refreshing the in-use sample-interval gate. Subsequent record()
   * sampling and maybeCompact()/compact() runs use the new values immediately. */
  setRetention(retention: Partial<RetentionConfig>): void {
    this.retention = { ...this.retention, ...retention };
    this.sampleIntervalMs = this.retention.sampleIntervalMs;
  }

  /** Ingest one host report at `now`: upsert each session into the registry
   * (marking it running, merging rollups), and diff against the prior tick for
   * this host to emit lifecycle events. (Samples/orphaning are later tasks.) */
  record(report: HostReport, now: number): RecordDiff {
    const prev = this.prevByHost.get(report.hostId) ?? new Map<string, Session>();
    const current = new Map<string, Session>();
    const closed: Session[] = [];
    const started: Session[] = [];
    const errored: Session[] = [];
    const attention: Session[] = [];
    const questsCompleted: { session: Session; item: WorkItem }[] = [];
    for (const session of report.sessions) current.set(sessionKeyOf(session), session);

    this.db.transaction(() => {
      // Sessions present now: upsert registry + diff against prev.
      for (const [key, session] of current) {
        const row = sessionToRow(session);
        const existing: any = this.selExisting.get(row.session_key);

        const incomingContext = session.contextTokens ?? 0;
        const peakContext = Math.max(existing?.peak_context_tokens ?? 0, incomingContext);

        const prevTools: string[] = existing?.tools_used ? JSON.parse(existing.tools_used) : [];
        const mergedTools = [...new Set([...prevTools, ...(session.toolsUsed ?? [])])];

        this.upsertSession.run({
          $session_key: row.session_key,
          $live_id: row.live_id,
          $resume_id: row.resume_id,
          $provider: row.provider,
          $host_id: row.host_id,
          $host_label: row.host_label,
          $cwd: row.cwd,
          $category: row.category,
          $model: row.model,
          $handle: row.handle,
          $display_name: row.display_name,
          $subject: row.subject,
          $started_at: row.started_at,
          $last_seen_at: now,
          $cost_usd: row.cost_usd,
          $tokens_in: row.tokens_in,
          $tokens_out: row.tokens_out,
          $tokens_cache_read: row.tokens_cache_read,
          $tokens_cache_write: row.tokens_cache_write,
          $peak_context_tokens: peakContext,
          $tools_used: JSON.stringify(mergedTools),
          $summary: session.summary ?? null,
          $attention: session.attention ? 1 : 0,
          $ask: session.ask ?? null,
          $suggestion: session.suggestion ?? null,
          $template_id: session.templateId ?? null,
        });

        for (const wi of session.workItems ?? []) {
          this.upsertWorkItem.run({
            $session_key: key,
            $item_key: wi.itemKey,
            $subject: wi.subject,
            $status: wi.status,
            $active_form: wi.activeForm ?? null,
            $position: wi.position ?? null,
            $now: now,
          });
        }

        for (const ss of session.subSessions ?? []) {
          this.upsertSubSession.run({
            $session_key: key,
            $agent_id: ss.agentId,
            $kind: ss.kind ?? null,
            $tokens_in: ss.tokensIn ?? null,
            $tokens_out: ss.tokensOut ?? null,
            $tokens_cache_read: ss.tokensCacheRead ?? null,
            $tokens_cache_write: ss.tokensCacheWrite ?? null,
            $cost_usd: ss.costUsd ?? null,
            $model: ss.model ?? null,
            $peak_context_tokens: ss.peakContextTokens ?? null,
            $tools_used: ss.toolsUsed ? JSON.stringify(ss.toolsUsed) : null,
            $first_at: ss.firstAt ?? null,
            $last_at: ss.lastAt ?? null,
          });
        }

        const before = prev.get(key);
        if (!before) {
          this.insertEvent({ at: now, sessionKey: key, type: "session.started",
            hostId: session.hostId, pid: session.pid });
          started.push(session);
          continue;
        }
        // active flip
        if ((before.active ?? false) !== (session.active ?? false)) {
          this.insertEvent({ at: now, sessionKey: key, type: "session.state",
            hostId: session.hostId, pid: session.pid,
            detail: { field: "active", from: before.active ?? false, to: session.active ?? false } });
        }
        // attention flip
        if ((before.attention ?? false) !== (session.attention ?? false)) {
          this.insertEvent({ at: now, sessionKey: key, type: "session.state",
            hostId: session.hostId, pid: session.pid,
            detail: { field: "attention", from: before.attention ?? false, to: session.attention ?? false } });
          if (session.attention) attention.push(session); // newly blocked, waiting on the user
        }
        // errored flip
        if ((before.errored ?? false) !== (session.errored ?? false)) {
          this.insertEvent({ at: now, sessionKey: key, type: "session.errored",
            hostId: session.hostId, pid: session.pid,
            detail: { from: before.errored ?? false, to: session.errored ?? false,
              transient: session.errorTransient ?? null } });
          if (session.errored) errored.push(session); // newly errored
        }
        // work items newly completed (TodoWrite "quest" done)
        const beforeStatus = new Map((before.workItems ?? []).map((w) => [w.itemKey, w.status]));
        for (const wi of session.workItems ?? []) {
          if (wi.status === "completed" && beforeStatus.get(wi.itemKey) !== "completed") {
            questsCompleted.push({ session, item: wi });
          }
        }
        // newly-seen tools
        const beforeTools = new Set(before.toolsUsed ?? []);
        for (const tool of session.toolsUsed ?? []) {
          if (!beforeTools.has(tool)) {
            this.insertEvent({ at: now, sessionKey: key, type: "session.tool",
              hostId: session.hostId, pid: session.pid, detail: { tool } });
          }
        }
      }

      // Per-session sample gate: write a raw sample only once per interval.
      for (const [key, session] of current) {
        if (now - (this.lastSampleAt.get(key) ?? -Infinity) < this.sampleIntervalMs) continue;
        this.insSample.run({
          $session_key: key,
          $at: now,
          $resolution: "raw",
          $tokens_in: session.tokensIn ?? null,
          $tokens_out: session.tokensOut ?? null,
          $tokens_cache_read: session.tokensCacheRead ?? null,
          $tokens_cache_write: session.tokensCacheWrite ?? null,
          $cost_usd: session.costUsd ?? null,
          $context_tokens: session.contextTokens ?? null,
          $context_window: session.contextWindow ?? null,
          $cpu: session.cpu ?? null,
          $mem_mb: session.memMb ?? null,
          $active: session.active ? 1 : 0,
        });
        this.lastSampleAt.set(key, now);
        // Piggyback activity time on the raw-sample gate: each active sampled tick
        // adds one interval to activeMs (downsample-proof; see design doc).
        if ((session.cpu ?? 0) > this.activeCpuThreshold || session.active === true) {
          this.accrueActiveMs.run({ $delta: this.sampleIntervalMs, $session_key: key });
        }
      }

      // Sessions present last tick for this host but gone now: closed.
      for (const [key, before] of prev) {
        if (current.has(key)) continue;
        this.insertEvent({ at: now, sessionKey: key, type: "session.closed",
          hostId: before.hostId, pid: before.pid });
        this.markClosed.run({ $ended_at: now, $session_key: key });
        closed.push(before);
      }
    })();

    this.prevByHost.set(report.hostId, current);
    return { started, closed, errored, attention, questsCompleted };
  }

  /** A whole host went offline (reporter disconnected / went stale). Mark its
   * still-running sessions `orphaned` — the processes may well be alive, we just
   * can't see them, so leave `ended_at` NULL (distinct from `closed`). Only
   * touches `running` rows; closed sessions are untouched. Drop the host's prev
   * snapshot so a returning reporter re-registers its sessions as started rather
   * than diffing against a stale tick (registry revival to 'running' happens
   * automatically via the next `record` upsert). */
  onHostOffline(hostId: string, now: number): void {
    this.orphanHost.run(now, hostId);
    this.prevByHost.delete(hostId);
  }

  /** Current on-disk size estimate (bytes) via PRAGMA page_count * page_size. */
  private dbSizeBytes(): number {
    const pc = this.db.query("PRAGMA page_count").get() as any;
    const ps = this.db.query("PRAGMA page_size").get() as any;
    return (pc?.page_count ?? 0) * (ps?.page_size ?? 0);
  }

  /** Promote one bucket's worth of finer samples into a single coarser row.
   * Selects rows at `fromResolution` older than `cutoff`, groups them in JS by
   * `bucketOf(at)`, inserts one condensed `toResolution` row per bucket (at the
   * bucket start), then deletes the consumed rows. Runs in a transaction. */
  private promote(
    fromResolution: "raw" | "hour",
    toResolution: "hour" | "day",
    bucketOf: (ms: number) => number,
    cutoff: number,
  ): void {
    const rows = this.db
      .query(
        `SELECT * FROM samples WHERE resolution = ? AND at < ? ORDER BY at`,
      )
      .all(fromResolution, cutoff) as any[];
    this.promoteRows(rows, fromResolution, toResolution, bucketOf);
  }

  /** Group already-selected `from` rows by bucket and condense them into `to`
   * rows, deleting the originals. Transactional. Grouping uses a nested
   * `sessionKey -> bucketStart -> rows[]` map so externally-sourced session keys
   * (which may contain spaces) are never string-encoded/parsed. */
  private promoteRows(
    rows: any[],
    fromResolution: "raw" | "hour",
    toResolution: "hour" | "day",
    bucketOf: (ms: number) => number,
  ): void {
    if (rows.length === 0) return;
    const groups = new Map<string, Map<number, any[]>>();
    for (const r of rows) {
      let byBucket = groups.get(r.session_key);
      if (!byBucket) groups.set(r.session_key, (byBucket = new Map()));
      const bucketStart = bucketOf(r.at);
      let bucketRows = byBucket.get(bucketStart);
      if (!bucketRows) byBucket.set(bucketStart, (bucketRows = []));
      bucketRows.push(r);
    }
    this.db.transaction(() => {
      const insert = this.db.query(
        `INSERT OR REPLACE INTO samples (
           session_key, at, resolution,
           tokens_in, tokens_out, tokens_cache_read, tokens_cache_write,
           cost_usd, context_tokens, context_window, cpu, mem_mb, active
         ) VALUES (
           $session_key, $at, $resolution,
           $tokens_in, $tokens_out, $tokens_cache_read, $tokens_cache_write,
           $cost_usd, $context_tokens, $context_window, $cpu, $mem_mb, $active
         )`,
      );
      const del = this.db.query(
        `DELETE FROM samples WHERE session_key = ? AND at = ? AND resolution = ?`,
      );
      for (const [sessionKey, byBucket] of groups) {
        for (const [bucketStart, bucketRows] of byBucket) {
          const c = condenseSamples(bucketRows);
          insert.run({
            $session_key: sessionKey,
            $at: bucketStart,
            $resolution: toResolution,
            $tokens_in: c.tokens_in,
            $tokens_out: c.tokens_out,
            $tokens_cache_read: c.tokens_cache_read,
            $tokens_cache_write: c.tokens_cache_write,
            $cost_usd: c.cost_usd,
            $context_tokens: c.context_tokens,
            $context_window: c.context_window,
            $cpu: c.cpu,
            $mem_mb: c.mem_mb,
            $active: c.active,
          });
          for (const r of bucketRows) del.run(r.session_key, r.at, fromResolution);
        }
      }
    })();
  }

  /** Run retention compaction at `now`:
   *  1. raw  -> hour  for samples older than rawDays
   *  2. hour -> day   for samples older than hourDays
   *  3. hard-delete events older than eventDays
   *  4. reconcile stale orphans: sessions stuck 'orphaned' past orphanCloseDays
   *     (the host never returned) become 'closed' with ended_at=last_seen_at.
   *  5. size ceiling: while the db exceeds maxBytes, promote the oldest still-raw
   *     hour-bucket early (raw->hour), preempting the age ladder. Sets and returns
   *     `sizePreempted` and warns when this happens. NOTE: under WAL the reported
   *     `page_count` does not shrink mid-loop (we neither checkpoint nor VACUUM
   *     here), so the size check never observes the freed space until after this
   *     run. Under genuine size pressure that means the loop drains ALL raw rows
   *     down to hour resolution rather than stopping at a precise byte target — a
   *     safe degradation (data is downsampled, not lost).
   * Registry (sessions) rows are never touched. */
  compact(now: number): { sizePreempted: boolean } {
    const { rawDays, hourDays, eventDays, maxBytes, orphanCloseDays } = this.retention;

    // 1. raw -> hour
    this.promote("raw", "hour", hourBucket, now - rawDays * DAY_MS);
    // 2. hour -> day
    this.promote("hour", "day", dayBucket, now - hourDays * DAY_MS);
    // 3. events past their window are hard-deleted.
    this.db.query("DELETE FROM events WHERE at < ?").run(now - eventDays * DAY_MS);
    // 4. reconcile stale orphans -> closed (ended_at = last_seen_at).
    this.closeStaleOrphans.run(now - orphanCloseDays * DAY_MS);

    // 5. size ceiling — promote the oldest raw hour-buckets early under size
    //    pressure. Because page_count won't shrink mid-loop under WAL (see the
    //    method doc), in practice this drains every raw row to hour resolution
    //    once we're over budget, then stops when no raw rows remain.
    let sizePreempted = false;
    while (this.dbSizeBytes() > maxBytes) {
      const oldest = this.db
        .query("SELECT at FROM samples WHERE resolution = 'raw' ORDER BY at LIMIT 1")
        .get() as any;
      if (!oldest) break;
      const bucketStart = hourBucket(oldest.at);
      const bucketRows = this.db
        .query(
          `SELECT * FROM samples WHERE resolution = 'raw' AND at >= ? AND at < ?`,
        )
        .all(bucketStart, bucketStart + HOUR_MS) as any[];
      this.promoteRows(bucketRows, "raw", "hour", hourBucket);
      sizePreempted = true;
    }
    if (sizePreempted) {
      console.warn(
        "[store] size ceiling exceeded (maxBytes=" +
          maxBytes +
          "); raw sample window shortened early by size pressure.",
      );
    }

    return { sizePreempted };
  }

  /** Run compact() only if at least compactIntervalMs has elapsed since the last
   * run. lastCompactAt starts at 0 so the very first call always runs. */
  maybeCompact(now: number): void {
    if (now - this.lastCompactAt < this.retention.compactIntervalMs) return;
    this.lastCompactAt = now;
    this.compact(now);
  }

  // ---- Read API -----------------------------------------------------------
  //
  // Query methods returning camelCase-mapped shapes from `@mc/shared`. All
  // dynamic WHERE clauses bind values as parameters (never string-interpolated)
  // to avoid injection. Row->camelCase mapping is centralized in the rowTo*
  // helpers below so column-name translation lives in one place.

  /** List registry rows, newest-first by `started_at`. All filters optional. */
  /** Build the shared WHERE clause + params for session list/count queries.
   * `minTokens` keeps sessions whose total tokens reach the floor OR are still
   * running (a live session under the floor must never be filtered out). */
  private sessionsWhere(filter: SessionFilter, except?: string): { clause: string; params: any[] } {
    const where: string[] = [];
    const params: any[] = [];
    const add = (clause: string, value: unknown) => { where.push(clause); params.push(value); };
    if (filter.state != null && except !== "state") add("state = ?", filter.state);
    if (filter.provider != null && except !== "provider") add("provider = ?", filter.provider);
    if (filter.category != null && except !== "category") add("category = ?", filter.category);
    if (filter.cwd != null && except !== "cwd") add("cwd = ?", filter.cwd);
    if (filter.host != null && except !== "host") add("host_id = ?", filter.host);
    if (filter.since != null) add("started_at >= ?", filter.since);
    if (filter.until != null) add("started_at <= ?", filter.until);
    if (filter.minTokens != null) {
      add(
        "((COALESCE(tokens_in,0)+COALESCE(tokens_out,0)+COALESCE(tokens_cache_read,0)+COALESCE(tokens_cache_write,0)) >= ? OR state = 'running')",
        filter.minTokens,
      );
    }
    if (filter.q != null && filter.q.trim() !== "") {
      const fields = ["display_name", "subject", "summary", "cwd", "handle", "provider", "model"];
      for (const term of filter.q.trim().split(/\s+/)) {
        where.push(`(${fields.map((f) => `${f} LIKE ?`).join(" OR ")})`);
        for (let i = 0; i < fields.length; i++) params.push(`%${term}%`);
      }
    }
    return { clause: where.length ? ` WHERE ${where.join(" AND ")}` : "", params };
  }

  /** A deduped view of `sessions` for the list/count read path: collapses legacy
   * near-duplicate rows that one logical daemon session produced before the
   * synthetic-key floor fix (same host/pid/provider, `started_at` within the same
   * second). Pre-fix, `sessionKeyOf` embedded raw-ms `startedAt`, so sub-second
   * jitter re-inserted a session under a NEW key every tick → many rows.
   *
   * GATED to SYNTHETIC-keyed rows only: a row counts as synthetic iff its
   * `session_key` matches the `host_id:<digits>:<digits>` shape (the
   * `${hostId}:${pid}:${ms}` pattern). Provider-native ids (claude/codex
   * UUIDs, etc.) never match that GLOB, so distinct native sessions sharing a
   * host/pid/second (e.g. after a pid reuse/restart) are NEVER merged — each
   * native row is its own group (group key = its session_key).
   *
   * For synthetic rows the group key reconstructs the floored canonical key:
   * the session_key with its trailing ms digits stripped (rtrim stops at the
   * `:` after pid) plus `started_at/1000` (integer seconds). `ROW_NUMBER` keeps
   * the most-complete/longest-lived row per group (running over closed, then
   * newest `last_seen_at`, then `ended_at`). Returned as a `deduped` subquery so
   * the existing WHERE/ORDER/LIMIT compose on top unchanged. */
  private static readonly DEDUPED_SESSIONS =
    `(SELECT * FROM (
        SELECT s.*, ROW_NUMBER() OVER (
          PARTITION BY CASE
            WHEN s.session_key GLOB s.host_id || ':[0-9]*:[0-9]*'
              THEN rtrim(s.session_key, '0123456789') || (s.started_at / 1000)
            ELSE s.session_key
          END
          ORDER BY (s.ended_at IS NULL) DESC, s.last_seen_at DESC, s.ended_at DESC
        ) AS _rn
        FROM sessions s
      ) WHERE _rn = 1)`;

  listSessions(filter: SessionFilter = {}): PersistedSession[] {
    const { clause, params } = this.sessionsWhere(filter);
    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    const col = SESSION_SORT_COLUMNS[filter.sort ?? "lastSeen"] ?? "last_seen_at";
    const dir = filter.order === "asc" ? "ASC" : "DESC";
    const sql = `SELECT * FROM ${Store.DEDUPED_SESSIONS}${clause} ORDER BY ${col} ${dir} NULLS LAST, started_at DESC LIMIT ? OFFSET ?`;
    const rows = this.db.query(sql).all(...params, limit, offset) as any[];
    return rows.map((r) => this.rowToSession(r));
  }

  /** Count sessions matching the filter (ignores limit/offset) — for pagination.
   * Counts the SAME deduped set listSessions returns, so paging totals match. */
  countSessions(filter: SessionFilter = {}): number {
    const { clause, params } = this.sessionsWhere(filter);
    const row: any = this.db.query(`SELECT COUNT(*) c FROM ${Store.DEDUPED_SESSIONS}${clause}`).get(...params);
    return row?.c ?? 0;
  }

  /** Fetch one registry row plus its recent events (newest-first). Null if the
   * session_key is unknown. */
  getSession(sessionKey: string): { session: PersistedSession; events: PersistedEvent[] } | null {
    const row: any = this.db.query("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey);
    if (!row) return null;
    const eventRows = this.db
      .query("SELECT * FROM events WHERE session_key = ? ORDER BY at DESC, id DESC LIMIT 100")
      .all(sessionKey) as any[];
    return {
      session: this.rowToSession(row),
      events: eventRows.map((e) => this.rowToEvent(e)),
    };
  }

  /** Work items ("quests") for one session, ordered by position then created. */
  getQuests(sessionKey: string): WorkItem[] {
    const rows = this.db
      .query("SELECT * FROM work_items WHERE session_key = ? ORDER BY position ASC, created_at ASC")
      .all(sessionKey) as any[];
    return rows.map((r) => this.rowToWorkItem(r));
  }

  /** Per-subagent usage breakdown for one session (Claude Task/Agent subagents),
   * ordered by first-seen then agent id. Empty for sessions without subagents. */
  getSubagents(sessionKey: string): PersistedSubSession[] {
    const rows = this.db
      .query("SELECT * FROM sub_sessions WHERE session_key = ? ORDER BY first_at ASC NULLS LAST, agent_id ASC")
      .all(sessionKey) as any[];
    return rows.map((r) => this.rowToSubSession(r));
  }

  private rowToSubSession(r: any): PersistedSubSession {
    return {
      sessionKey: r.session_key,
      agentId: r.agent_id,
      kind: r.kind ?? undefined,
      tokensIn: r.tokens_in ?? undefined,
      tokensOut: r.tokens_out ?? undefined,
      tokensCacheRead: r.tokens_cache_read ?? undefined,
      tokensCacheWrite: r.tokens_cache_write ?? undefined,
      costUsd: r.cost_usd ?? undefined,
      model: r.model ?? undefined,
      peakContextTokens: r.peak_context_tokens ?? undefined,
      toolsUsed: r.tools_used ? JSON.parse(r.tools_used) : undefined,
      firstAt: r.first_at ?? undefined,
      lastAt: r.last_at ?? undefined,
    };
  }

  /** One-time, idempotent migration: for sessions whose active_ms IS NULL,
   * compute it from existing raw samples — `(count of raw samples that are active)
   * * sampleIntervalMs`, where a sample is active when cpu>threshold OR active=1.
   * Only touches NULL rows, so a live-accumulated activeMs is never overwritten and
   * re-runs are no-ops. A single grouped UPDATE (the real DB has ~210k raw rows). */
  backfillActiveMs(): void {
    this.db
      .query(
        `UPDATE sessions SET active_ms = COALESCE((
           SELECT COUNT(*) FROM samples
           WHERE samples.session_key = sessions.session_key
             AND samples.resolution = 'raw'
             AND (COALESCE(samples.cpu, 0) > $threshold OR samples.active > 0)
         ), 0) * $interval
         WHERE active_ms IS NULL`,
      )
      .run({ $threshold: this.activeCpuThreshold, $interval: this.sampleIntervalMs });
  }

  private rowToWorkItem(r: any): WorkItem {
    return {
      itemKey: r.item_key,
      subject: r.subject,
      status: r.status,
      activeForm: r.active_form ?? undefined,
      position: r.position ?? undefined,
    };
  }

  // ---- Templates ("templates") ------------------------------------------------

  /** Create or replace a spawn template. Upsert on id — re-creating an archived
   * id revives it (archived_at reset to NULL). */
  createTemplate(t: { id: string; name: string; provider: string; args: string[]; prompt?: string; cwd?: string; backend?: SpawnBackend; rpg?: Record<string, unknown>; createdAt: number }): void {
    this.db.query(
      `INSERT INTO templates (id, name, provider, args_json, prompt, cwd, rpg_json, backend, created_at, archived_at)
       VALUES ($id,$name,$provider,$args,$prompt,$cwd,$rpg,$backend,$created,NULL)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider=excluded.provider,
         args_json=excluded.args_json, prompt=excluded.prompt, cwd=excluded.cwd,
         rpg_json=excluded.rpg_json, backend=excluded.backend, archived_at=NULL`,
    ).run({
      $id: t.id, $name: t.name, $provider: t.provider,
      $args: JSON.stringify(t.args ?? []), $prompt: t.prompt ?? null,
      $cwd: t.cwd ?? null, $rpg: t.rpg ? JSON.stringify(t.rpg) : null,
      $backend: t.backend ?? DEFAULT_BACKEND, $created: t.createdAt,
    });
  }

  /** Patch a template in place (preserving created_at). Returns false if unknown.
   * Note: delegates to createTemplate, so patching an archived template REVIVES it
   * (archived_at reset to NULL). */
  updateTemplate(id: string, patch: Partial<{ name: string; provider: string; args: string[]; prompt: string; cwd: string; backend: SpawnBackend; rpg: Record<string, unknown> }>): boolean {
    const cur = this.getTemplateRow(id);
    if (!cur) return false;
    this.createTemplate({
      id, createdAt: cur.created_at,
      name: patch.name ?? cur.name, provider: patch.provider ?? cur.provider,
      args: patch.args ?? JSON.parse(cur.args_json ?? "[]"),
      prompt: patch.prompt ?? cur.prompt ?? undefined,
      cwd: patch.cwd ?? cur.cwd ?? undefined,
      backend: patch.backend ?? (cur.backend as SpawnBackend) ?? undefined,
      rpg: patch.rpg ?? (cur.rpg_json ? JSON.parse(cur.rpg_json) : undefined),
    });
    return true;
  }

  /** Soft-archive a template. Returns false if already archived or unknown. */
  archiveTemplate(id: string, now: number): boolean {
    const r = this.db.query("UPDATE templates SET archived_at = ? WHERE id = ? AND archived_at IS NULL").run(now, id);
    return r.changes > 0;
  }

  private getTemplateRow(id: string): any {
    return this.db.query("SELECT * FROM templates WHERE id = ?").get(id);
  }

  /** Fetch one template (by id) with its derived XP, or null. Archived rows included. */
  getTemplate(id: string): TemplateWithXp | null {
    const row = this.getTemplateRow(id);
    return row ? this.rowToTemplate(row) : null;
  }

  /** Active (non-archived) templates with derived XP. */
  listTemplates(): TemplateWithXp[] {
    const rows = this.db.query("SELECT * FROM templates WHERE archived_at IS NULL ORDER BY created_at").all() as any[];
    return rows.map((r) => this.rowToTemplate(r));
  }

  private rowToTemplate(r: any): TemplateWithXp {
    const x = this.db.query(
      `SELECT COUNT(*) AS troops, COALESCE(SUM(cost_usd),0) AS cost,
              COALESCE(SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)),0) AS tokens,
              MAX(last_seen_at) AS last
       FROM sessions WHERE template_id = ?`,
    ).get(r.id) as any;
    return {
      id: r.id, name: r.name, provider: r.provider,
      args: JSON.parse(r.args_json ?? "[]"),
      prompt: r.prompt ?? undefined, cwd: r.cwd ?? undefined,
      backend: (r.backend as SpawnBackend) ?? DEFAULT_BACKEND,
      rpg: r.rpg_json ? JSON.parse(r.rpg_json) : undefined,
      createdAt: r.created_at, archivedAt: r.archived_at ?? undefined,
      troopsDeployed: x.troops, totalCost: x.cost, totalTokens: x.tokens,
      lastDeploy: x.last ?? null, level: templateLevel(x.troops, x.tokens),
    };
  }

  /** Cross-session quest board: work items joined to their session, newest-updated first. */
  listQuests(filter: QuestFilter = {}): QuestRow[] {
    const where: string[] = [];
    const params: any[] = [];
    const add = (clause: string, value: unknown) => { where.push(clause); params.push(value); };
    if (filter.status != null) add("w.status = ?", filter.status);
    if (filter.provider != null) add("s.provider = ?", filter.provider);
    if (filter.category != null) add("s.category = ?", filter.category);
    if (filter.sessionState != null) add("s.state = ?", filter.sessionState);
    const limit = Math.min(2000, filter.limit ?? 500);
    const sql =
      `SELECT w.*, s.provider, s.category, s.display_name, s.host_label, s.state AS session_state
       FROM work_items w JOIN sessions s ON s.session_key = w.session_key` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY w.updated_at DESC LIMIT ?`;
    const rows = this.db.query(sql).all(...params, limit) as any[];
    return rows.map((r) => ({
      ...this.rowToWorkItem(r),
      sessionKey: r.session_key,
      provider: r.provider,
      category: r.category,
      displayName: r.display_name ?? undefined,
      hostLabel: r.host_label,
      sessionState: r.session_state,
      updatedAt: r.updated_at,
    }));
  }

  // ---- managed quests (user-assigned; distinct from passive work_items) -------

  /** Create a managed quest. Owned by a lord (templateId) and/or a session. */
  createQuest(q: {
    subject: string; body?: string; status?: QuestStatus;
    templateId?: string; sessionKey?: string; now: number;
  }): Quest {
    const id = `q_${crypto.randomUUID()}`;
    const row = {
      id, subject: q.subject, body: q.body ?? null, status: q.status ?? "pending",
      template_id: q.templateId ?? null, session_key: q.sessionKey ?? null,
      created_at: q.now, updated_at: q.now,
    };
    this.db.query(
      `INSERT INTO quests (id, subject, body, status, template_id, session_key, created_at, updated_at)
       VALUES ($id, $subject, $body, $status, $template_id, $session_key, $created_at, $updated_at)`,
    ).run({
      $id: row.id, $subject: row.subject, $body: row.body, $status: row.status,
      $template_id: row.template_id, $session_key: row.session_key,
      $created_at: row.created_at, $updated_at: row.updated_at,
    });
    return this.getQuest(id)!;
  }

  /** Patch a managed quest (subject/body/status/owner). Returns false if unknown. */
  updateQuest(
    id: string,
    patch: { subject?: string; body?: string; status?: QuestStatus; templateId?: string | null; sessionKey?: string | null },
    now: number,
  ): boolean {
    const sets: string[] = [];
    const params: any[] = [];
    const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); params.push(v); };
    if (patch.subject !== undefined) set("subject", patch.subject);
    if (patch.body !== undefined) set("body", patch.body ?? null);
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.templateId !== undefined) set("template_id", patch.templateId);
    if (patch.sessionKey !== undefined) set("session_key", patch.sessionKey);
    if (!sets.length) return !!this.getQuest(id);
    set("updated_at", now);
    const r = this.db.query(`UPDATE quests SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    return r.changes > 0;
  }

  deleteQuest(id: string): boolean {
    return this.db.query("DELETE FROM quests WHERE id = ?").run(id).changes > 0;
  }

  getQuest(id: string): Quest | null {
    const r = this.db.query("SELECT * FROM quests WHERE id = ?").get(id) as any;
    return r ? this.rowToQuest(r) : null;
  }

  /** A lord's quests (for folding into marching orders at deploy). */
  questsForTemplate(templateId: string, status?: QuestStatus): Quest[] {
    const rows = status
      ? this.db.query("SELECT * FROM quests WHERE template_id = ? AND status = ? ORDER BY created_at").all(templateId, status)
      : this.db.query("SELECT * FROM quests WHERE template_id = ? ORDER BY created_at").all(templateId);
    return (rows as any[]).map((r) => this.rowToQuest(r));
  }

  /** Managed quest board, enriched with lord/session display context. */
  listManagedQuests(filter: { status?: QuestStatus; templateId?: string; sessionKey?: string } = {}): QuestView[] {
    const where: string[] = [];
    const params: any[] = [];
    const add = (clause: string, value: unknown) => { where.push(clause); params.push(value); };
    if (filter.status != null) add("q.status = ?", filter.status);
    if (filter.templateId != null) add("q.template_id = ?", filter.templateId);
    if (filter.sessionKey != null) add("q.session_key = ?", filter.sessionKey);
    const sql =
      `SELECT q.*, t.name AS template_name, t.provider AS template_provider,
              s.provider AS session_provider, s.display_name AS session_display_name,
              s.state AS session_state, s.host_label AS host_label
       FROM quests q
       LEFT JOIN templates t ON t.id = q.template_id
       LEFT JOIN sessions s ON s.session_key = q.session_key` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY q.updated_at DESC`;
    const rows = this.db.query(sql).all(...params) as any[];
    return rows.map((r) => ({
      ...this.rowToQuest(r),
      templateName: r.template_name ?? undefined,
      provider: r.session_provider ?? r.template_provider ?? undefined,
      sessionDisplayName: r.session_display_name ?? undefined,
      sessionState: r.session_state ?? undefined,
      hostLabel: r.host_label ?? undefined,
    }));
  }

  private rowToQuest(r: any): Quest {
    return {
      id: r.id, subject: r.subject, body: r.body ?? undefined, status: r.status,
      templateId: r.template_id ?? undefined, sessionKey: r.session_key ?? undefined,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  /** Faceted counts for filter chips. Each dimension is computed with all active
   * filters EXCEPT its own (standard self-excluding faceting), so a dropdown stays
   * navigable after you pick a value from it. */
  facets(filter: SessionFilter = {}): Facets {
    const dim = (col: string, except: string): FacetBucket[] => {
      const { clause, params } = this.sessionsWhere(filter, except);
      const rows = this.db
        .query(`SELECT ${col} AS value, COUNT(*) c FROM sessions${clause} GROUP BY ${col} ORDER BY c DESC`)
        .all(...params) as any[];
      return rows.filter((r) => r.value != null).map((r) => ({ value: String(r.value), count: r.c }));
    };
    const hosts = (() => {
      const { clause, params } = this.sessionsWhere(filter, "host");
      const rows = this.db
        .query(`SELECT host_id AS value, host_label AS label, COUNT(*) c FROM sessions${clause} GROUP BY host_id ORDER BY c DESC`)
        .all(...params) as any[];
      return rows
        .filter((r) => r.value != null)
        .map((r) => ({ value: String(r.value), count: r.c, label: r.label ?? undefined }));
    })();
    return {
      providers: dim("provider", "provider"),
      categories: dim("category", "category"),
      states: dim("state", "state"),
      hosts,
    };
  }

  /** Bucketed cost/token rollup. Samples are cumulative, so spend-per-bucket is a
   * per-session delta across consecutive samples (clamped >= 0), summed into
   * buckets. Reads across resolutions: all rows in the window participate, ordered
   * per session by `at`, so long windows fall back to coarser (hour/day) tiers
   * where raw has been compacted away. First in-window sample per session yields a
   * null delta (contributes 0) — spend before the window is invisible. */
  timeseries(opts: {
    since: number;
    until: number;
    bucket?: "hour" | "day";
    metric?: "cost" | "tokens";
    groupBy?: "none" | "category" | "provider";
    provider?: string;
    category?: string;
    host?: string;
  }): TimeseriesResponse {
    const bucket = opts.bucket ?? "day";
    const metric = opts.metric ?? "cost";
    const groupBy = opts.groupBy ?? "none";
    const bucketOf = bucket === "hour" ? hourBucket : dayBucket;
    const step = bucket === "hour" ? HOUR_MS : DAY_MS;
    const metricCol =
      metric === "cost"
        ? "s.cost_usd"
        : "(COALESCE(s.tokens_in,0)+COALESCE(s.tokens_out,0)+COALESCE(s.tokens_cache_read,0)+COALESCE(s.tokens_cache_write,0))";

    const where = ["s.at >= ?", "s.at <= ?"];
    const params: any[] = [opts.since, opts.until];
    if (opts.provider != null) { where.push("se.provider = ?"); params.push(opts.provider); }
    if (opts.category != null) { where.push("se.category = ?"); params.push(opts.category); }
    if (opts.host != null) { where.push("se.host_id = ?"); params.push(opts.host); }
    const groupCol =
      groupBy === "category" ? "se.category" : groupBy === "provider" ? "se.provider" : "''";

    const sql = `
      SELECT d.at AS at, d.grp AS grp, MAX(d.delta, 0) AS value FROM (
        SELECT s.at AS at, ${groupCol} AS grp,
          ${metricCol} - LAG(${metricCol}) OVER (PARTITION BY s.session_key ORDER BY s.at) AS delta
        FROM samples s JOIN sessions se ON se.session_key = s.session_key
        WHERE ${where.join(" AND ")}
      ) d WHERE d.delta IS NOT NULL`;
    const rows = this.db.query(sql).all(...params) as any[];

    const buckets: number[] = [];
    for (let t = bucketOf(opts.since); t <= opts.until; t += step) buckets.push(t);
    const byGroup = new Map<string, Map<number, number>>();
    for (const r of rows) {
      const key = String(r.grp ?? "");
      const t = bucketOf(r.at);
      const m = byGroup.get(key) ?? new Map<number, number>();
      m.set(t, (m.get(t) ?? 0) + r.value);
      byGroup.set(key, m);
    }
    if (byGroup.size === 0) byGroup.set("", new Map());
    const series: TimeseriesSeries[] = [...byGroup.entries()].map(([key, m]) => ({
      key,
      points: buckets.map((t) => ({ t, value: m.get(t) ?? 0 })),
    }));
    return { bucket, metric, series };
  }

  /** Time-series samples for a session, ASC by `at` (graphing order). With
   * `resolution:"auto"` (default) the tier is chosen from the requested span:
   * span <= rawDays → 'raw'; else <= hourDays → 'hour'; else 'day'. When neither
   * `since` nor `until` is given, auto resolves to 'raw'. */
  getSamples(
    sessionKey: string,
    opts: { since?: number; until?: number; resolution?: "raw" | "hour" | "day" | "auto" } = {},
  ): SessionSample[] {
    const resolution =
      opts.resolution && opts.resolution !== "auto"
        ? opts.resolution
        : this.autoResolution(opts.since, opts.until);
    const where = ["session_key = ?", "resolution = ?"];
    const params: any[] = [sessionKey, resolution];
    const add = (clause: string, value: unknown) => { where.push(clause); params.push(value); };
    if (opts.since != null) add("at >= ?", opts.since);
    if (opts.until != null) add("at <= ?", opts.until);
    const rows = this.db
      .query(`SELECT * FROM samples WHERE ${where.join(" AND ")} ORDER BY at ASC`)
      .all(...params) as any[];
    return rows.map((r) => this.rowToSample(r));
  }

  /** List events, newest-first by `at`. All filters optional. */
  listEvents(filter: {
    type?: PersistedEventType;
    sessionKey?: string;
    since?: number;
    until?: number;
    limit?: number;
  } = {}): PersistedEvent[] {
    const where: string[] = [];
    const params: any[] = [];
    const add = (clause: string, value: unknown) => { where.push(clause); params.push(value); };
    if (filter.type != null) add("type = ?", filter.type);
    if (filter.sessionKey != null) add("session_key = ?", filter.sessionKey);
    if (filter.since != null) add("at >= ?", filter.since);
    if (filter.until != null) add("at <= ?", filter.until);
    const limit = filter.limit ?? 200;
    const sql =
      "SELECT * FROM events" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY at DESC, id DESC LIMIT ?";
    const rows = this.db.query(sql).all(...params, limit) as any[];
    return rows.map((r) => this.rowToEvent(r));
  }

  /** Pick a sample resolution from the requested span. No since/until → 'raw'.
   * Note: a single open bound (only since OR only until) yields span 0 → 'raw';
   * callers wanting a coarse tier over an open range should pass both since and
   * until (raw may have been compacted away, returning fewer rows than expected). */
  private autoResolution(since?: number, until?: number): "raw" | "hour" | "day" {
    if (since == null && until == null) return "raw";
    const span = (until ?? since ?? 0) - (since ?? until ?? 0);
    if (span <= this.retention.rawDays * DAY_MS) return "raw";
    if (span <= this.retention.hourDays * DAY_MS) return "hour";
    return "day";
  }

  private rowToSession(r: any): PersistedSession {
    return {
      sessionKey: r.session_key,
      liveId: r.live_id,
      resumeId: r.resume_id ?? undefined,
      provider: r.provider,
      hostId: r.host_id,
      hostLabel: r.host_label,
      cwd: r.cwd,
      category: r.category,
      model: r.model ?? undefined,
      handle: r.handle ?? undefined,
      displayName: r.display_name ?? undefined,
      subject: r.subject ?? undefined,
      startedAt: r.started_at,
      endedAt: r.ended_at ?? undefined,
      state: r.state,
      lastSeenAt: r.last_seen_at,
      costUsd: r.cost_usd ?? undefined,
      tokensIn: r.tokens_in ?? undefined,
      tokensOut: r.tokens_out ?? undefined,
      tokensCacheRead: r.tokens_cache_read ?? undefined,
      tokensCacheWrite: r.tokens_cache_write ?? undefined,
      peakContextTokens: r.peak_context_tokens ?? undefined,
      toolsUsed: r.tools_used ? JSON.parse(r.tools_used) : undefined,
      summary: r.summary ?? undefined,
      attention: r.attention == null ? undefined : !!r.attention,
      ask: r.ask ?? undefined,
      suggestion: r.suggestion ?? undefined,
      activeMs: r.active_ms ?? undefined,
    };
  }

  private rowToSample(r: any): SessionSample {
    return {
      sessionKey: r.session_key,
      at: r.at,
      resolution: r.resolution,
      tokensIn: r.tokens_in ?? undefined,
      tokensOut: r.tokens_out ?? undefined,
      tokensCacheRead: r.tokens_cache_read ?? undefined,
      tokensCacheWrite: r.tokens_cache_write ?? undefined,
      costUsd: r.cost_usd ?? undefined,
      contextTokens: r.context_tokens ?? undefined,
      contextWindow: r.context_window ?? undefined,
      cpu: r.cpu ?? undefined,
      memMb: r.mem_mb ?? undefined,
      active: r.active ?? undefined,
    };
  }

  private rowToEvent(r: any): PersistedEvent {
    return {
      at: r.at,
      sessionKey: r.session_key,
      type: r.type,
      hostId: r.host_id ?? undefined,
      pid: r.pid ?? undefined,
      detail: r.detail ? JSON.parse(r.detail) : undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}
