import type { Session } from "@mc/shared";
import { useTimeseries, type TimeseriesSeries } from "./useQuery.ts";
import { battleStateOf, charName, classOf, gold, type BattleState } from "./rpg.ts";
import { fmtCost } from "./format.ts";
import { useLex } from "./lexicon.ts";

const DAY = 86_400_000;

/** A state count that doubles as a quick filter toggle. */
function StatePill({ state, tone, n, label, filter, onToggle }: {
  state: BattleState; tone?: string; n: number; label: string;
  filter: Set<BattleState>; onToggle: (s: BattleState) => void;
}) {
  const active = filter.has(state);
  return (
    <button
      type="button"
      className={`pill filter${tone ? " " + tone : ""}`}
      data-active={active || undefined}
      aria-pressed={active}
      title={`Filter: show only ${label}`}
      onClick={() => onToggle(state)}
    >
      <b>{n}</b> {label}
    </button>
  );
}

/** Compact one-line live counts for the top of the party (monitoring) page.
 * The state blocks double as quick filters; clicking the total ("processes")
 * resets to show everything. Counts are always the LIVE totals (so a hidden
 * state still shows how many it holds). The heavy analytics live in <Dashboard>. */
export function LiveStrip({ sessions, filter, onToggleState, onResetStates }: {
  sessions: Session[];
  filter?: Set<BattleState>;
  onToggleState?: (s: BattleState) => void;
  onResetStates?: () => void;
}) {
  const lex = useLex();
  const battle = sessions.filter((s) => battleStateOf(s) === "battle").length;
  const awaiting = sessions.filter((s) => battleStateOf(s) === "awaiting").length;
  const resting = sessions.filter((s) => battleStateOf(s) === "resting").length;
  const ko = sessions.filter((s) => battleStateOf(s) === "ko").length;
  const cost = sessions.reduce((a, s) => a + (s.costUsd ?? 0), 0);

  // Interactive mode requires both the filter set and the toggle handler.
  const interactive = !!filter && !!onToggleState;
  const f = filter ?? new Set<BattleState>();
  const toggle = onToggleState ?? (() => {});

  if (!interactive) {
    // Static fallback (no filter wiring) — keeps LiveStrip usable standalone.
    return (
      <div className="win livestrip">
        <span className="pill"><b>{sessions.length}</b> {lex.heroes}</span>
        <span className="pill battle"><b>{battle}</b> {lex.stat.inBattle}</span>
        <span className="pill awaiting"><b>{awaiting}</b> {lex.stat.awaiting}</span>
        <span className="pill"><b>{resting}</b> {lex.stat.idle}</span>
        {ko > 0 && <span className="pill ko"><b>{ko}</b> {lex.stat.ko}</span>}
        <span className="pill gold"><b>{fmtCost(cost)}</b> {lex.stat.gilRate}</span>
      </div>
    );
  }

  const none = f.size === 0;
  return (
    <div className="win livestrip">
      <button
        type="button"
        className="pill filter"
        data-active={none || undefined}
        aria-pressed={none}
        title="Show all states"
        onClick={() => onResetStates?.()}
      >
        <b>{sessions.length}</b> {lex.heroes}
      </button>
      <StatePill state="battle" tone="battle" n={battle} label={lex.stat.inBattle} filter={f} onToggle={toggle} />
      <StatePill state="awaiting" tone="awaiting" n={awaiting} label={lex.stat.awaiting} filter={f} onToggle={toggle} />
      <StatePill state="resting" n={resting} label={lex.stat.idle} filter={f} onToggle={toggle} />
      <StatePill state="ko" tone="ko" n={ko} label={lex.stat.ko} filter={f} onToggle={toggle} />
      <span className="pill gold"><b>{fmtCost(cost)}</b> {lex.stat.gilRate}</span>
    </div>
  );
}

/** Pure: build an SVG area+line path pair for a series in a wxh box. */
function paths(series: TimeseriesSeries | undefined, w: number, h: number): { line: string; area: string } {
  const pts = series?.points ?? [];
  if (pts.length === 0) return { line: "", area: "" };
  const max = Math.max(1, ...pts.map((p) => p.value));
  const stepX = pts.length > 1 ? w / (pts.length - 1) : 0;
  const xy = pts.map((p, i) => [Math.round(i * stepX), Math.round(h - (p.value / max) * (h - 4) - 2)]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
  const area = `${line} L${xy[xy.length - 1][0]} ${h} L${xy[0][0]} ${h} Z`;
  return { line, area };
}

function Stat({ v, k, tone }: { v: string | number; k: string; tone?: string }) {
  return (
    <div className="stat" data-tone={tone}>
      <span className="v">{v}</span>
      <span className="k">{k}</span>
    </div>
  );
}

export function Dashboard({ sessions, now }: { sessions: Session[]; now: number }) {
  const lex = useLex();
  const battle = sessions.filter((s) => battleStateOf(s) === "battle").length;
  const awaiting = sessions.filter((s) => battleStateOf(s) === "awaiting").length;
  const ko = sessions.filter((s) => battleStateOf(s) === "ko").length;
  const gil = sessions.reduce((a, s) => a + (s.costUsd ?? 0), 0);

  const top = [...sessions].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)).slice(0, 5);

  const ts = useTimeseries({ since: now - 14 * DAY, until: now, bucket: "day", metric: "cost" });
  const W = 280, H = 78;
  const { line, area } = paths(ts.data.series[0], W, H);
  const total14 = (ts.data.series[0]?.points ?? []).reduce((a, p) => a + p.value, 0);

  return (
    <div className="dash">
      <div className="win panel">
        <div className="cap">⚔ {lex.partyStatus}</div>
        <div className="statgrid">
          <Stat v={sessions.length} k={lex.stat.heroes} />
          <Stat v={battle} k={lex.stat.inBattle} tone="battle" />
          <Stat v={awaiting} k={lex.stat.awaiting} tone="awaiting" />
          <Stat v={ko} k={lex.stat.ko} tone={ko ? "ko" : undefined} />
          <Stat v={fmtCost(gil)} k={lex.stat.gilRate} tone="gold" />
          <Stat v={new Set(sessions.map((s) => s.hostId)).size} k={lex.stat.realms} />
          <Stat v={new Set(sessions.map((s) => s.provider)).size} k={lex.stat.classes} />
          <Stat v={sessions.reduce((a, s) => a + (s.workItems?.filter((w) => w.status !== "completed").length ?? 0), 0)} k={lex.stat.quests} tone="gold" />
        </div>
      </div>

      <div className="win panel">
        <div className="cap">📜 {lex.spent} · 14 days <span style={{ marginLeft: "auto", color: "var(--gold)" }}>{fmtCost(total14)}</span></div>
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" height={H}>
          {[0.25, 0.5, 0.75].map((g) => <line key={g} className="gline" x1={0} x2={W} y1={H * g} y2={H * g} />)}
          {area && <path className="area" d={area} />}
          {line && <path className="line" d={line} />}
        </svg>
      </div>

      <div className="win panel">
        <div className="cap">🏆 {lex.leaderboard}</div>
        <div className="board">
          {top.length === 0 && <span style={{ color: "var(--ink-faint)", fontSize: 13 }}>—</span>}
          {top.map((s, i) => (
            <div className="row" key={s.id}>
              <span className="rank">{i + 1}</span>
              <span className="who">{classOf(s.provider).sigil} {charName(s)} <small>· {fmtCost(s.costUsd)}</small></span>
              <span className="amt">{lex.gilGlyph}{gold(s.costUsd)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
