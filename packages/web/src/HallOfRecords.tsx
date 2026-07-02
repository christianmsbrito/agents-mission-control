import { useEffect, useMemo, useState } from "react";
import { resumeCommand, type PersistedSession } from "@mc/shared";
import { useHistory, historyQueryString, type HistoryFilter } from "./useHistory.ts";
import { useFacets } from "./useQuery.ts";
import { FacetBar, type FacetSel } from "./FacetBar.tsx";
import { classOf, charName, gold, xpOf, levelOf, activeFraction, type FateState } from "./rpg.ts";
import { fmtUptime, fmtTokens, fmtDate, dayLabel, fmtAgo } from "./format.ts";
import { useLex } from "./lexicon.ts";

const PAGE = 60;

// time-range presets -> `since` (ms). null = all time.
const RANGES: { id: string; label: string; since: (now: number) => number | undefined }[] = [
  { id: "all", label: "All", since: () => undefined },
  { id: "today", label: "Today", since: (n) => { const d = new Date(n); d.setHours(0, 0, 0, 0); return d.getTime(); } },
  { id: "7d", label: "7d", since: (n) => n - 7 * 86_400_000 },
  { id: "30d", label: "30d", since: (n) => n - 30 * 86_400_000 },
];

// sortable columns -> API sort key
type SortKey = "started" | "tokens" | "cost" | "context";
type Sort = { key: SortKey; dir: "asc" | "desc" };

function Th({ label, col, sort, onSort, align }: {
  label: string; col?: SortKey; sort: Sort; onSort: (k: SortKey) => void; align?: "right";
}) {
  if (!col) return <span className="th" data-align={align}>{label}</span>;
  const active = sort.key === col;
  return (
    <button className="th sortable" data-align={align} aria-pressed={active} onClick={() => onSort(col)}>
      {label}<span className="arrow">{active ? (sort.dir === "desc" ? "▾" : "▴") : "·"}</span>
    </button>
  );
}

function Row({ s, now, lex, onOpen }: { s: PersistedSession; now: number; lex: ReturnType<typeof useLex>; onOpen: (k: string) => void }) {
  const cls = classOf(s.provider);
  const job = lex.jobs[s.provider] ?? lex.jobFallback;
  const title = s.subject || s.summary || charName(s);
  const dur = s.endedAt ? fmtUptime(s.startedAt, s.endedAt) : "live";
  const active = activeFraction(s);
  const resume = resumeCommand(s);
  return (
    <div className="win rec" onClick={() => onOpen(s.sessionKey)} style={{ ["--hue" as any]: cls.hue }}>
      <span className="sig">{cls.sigil}</span>
      <span className="who">
        <span className="nm" title={title}>{title}</span>
        <span className="sub">
          {charName(s)} · {lex.level}.{levelOf(s)} {job} · {s.category}
          {s.model ? ` · ${s.model.replace(/^claude-|-\d.*$/g, "")}` : ""} · {s.hostLabel}
        </span>
      </span>
      <span className="col started" data-align="right">
        <span>{fmtDate(s.startedAt, now)}</span>
        <span className="k">{fmtAgo(s.endedAt ?? s.lastSeenAt, now)}</span>
      </span>
      <span className="col" data-align="right"><span>{dur}</span><span className="k">dur</span></span>
      <span className="col" data-align="right"><span>{active != null ? `${Math.round(active * 100)}%` : "—"}</span><span className="k">active</span></span>
      <span className="col" data-align="right"><span>{fmtTokens(xpOf(s))}</span><span className="k">{lex.xp.toLowerCase()}</span></span>
      <span className="col gil" data-align="right"><span>{lex.gilGlyph}{gold(s.costUsd)}</span><span className="k">{lex.gil}</span></span>
      <span className="fate" data-f={s.state}>{lex.fate[s.state as FateState] ?? s.state}</span>
      <span className="rec-act">
        {resume && (
          <button className="icon-btn sm" title="copy resume command"
            onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(resume); }}>⧉</button>
        )}
      </span>
    </div>
  );
}

export function HallOfRecords({
  q, sel, onToggleFacet, onClear, now, onOpen,
}: {
  q: string;
  sel: FacetSel;
  onToggleFacet: (d: keyof FacetSel, v: string) => void;
  onClear: () => void;
  now: number;
  onOpen: (key: string) => void;
}) {
  const lex = useLex();
  const [range, setRange] = useState("all");
  const [sort, setSort] = useState<Sort>({ key: "started", dir: "desc" });
  const [page, setPage] = useState(0);

  const since = RANGES.find((r) => r.id === range)!.since(now);

  // reset to page 0 whenever the result set changes
  useEffect(() => { setPage(0); }, [q, sel.provider, sel.category, sel.host, sel.state, range, sort.key, sort.dir]);

  const baseFilter: HistoryFilter = {
    q: q || undefined,
    state: sel.state,
    provider: sel.provider,
    category: sel.category,
    host: sel.host,
    since,
  };
  const facets = useFacets(historyQueryString(baseFilter));
  const { sessions, total, loading, error } = useHistory({
    ...baseFilter, sort: sort.key, order: sort.dir, limit: PAGE, offset: page * PAGE,
  });

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));

  const hasFilters = !!(q || sel.provider || sel.category || sel.host || sel.state || range !== "all");

  // group rows by day only when sorting by start time (otherwise a flat list)
  const groups = useMemo(() => {
    if (sort.key !== "started") return [{ label: "", rows: sessions }];
    const out: { label: string; rows: PersistedSession[] }[] = [];
    for (const s of sessions) {
      const label = dayLabel(s.startedAt, now);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(s);
      else out.push({ label, rows: [s] });
    }
    return out;
  }, [sessions, sort.key, now]);

  return (
    <div className="scroll">
      {/* toolbar: facet chips + time range + clear + count */}
      <div className="rec-toolbar">
        <FacetBar facets={facets.data} sel={sel} onToggle={onToggleFacet} showState />
        <span className="seg sm">
          {RANGES.map((r) => (
            <button key={r.id} aria-pressed={range === r.id} onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
        </span>
        {hasFilters && <button className="cmd sm" onClick={() => { onClear(); setRange("all"); }}>✕ clear</button>}
        <span className="rec-count">{loading ? "…" : `${total} ${total === 1 ? lex.hero : lex.heroes}`}</span>
      </div>

      {error && <div className="empty"><span className="big">{error}</span></div>}
      {!error && !loading && sessions.length === 0 && (
        <div className="empty"><span className="crest">🏛</span><span className="big">{lex.recordsEmpty}</span></div>
      )}

      {!error && sessions.length > 0 && (
        <div className="rec-table">
          <div className="rec-head">
            <span className="th" /><span className="th">{/* title */}</span>
            <Th label="Started" col="started" sort={sort} onSort={onSort} align="right" />
            <span className="th" data-align="right">Dur</span>
            <span className="th" data-align="right">Active</span>
            <Th label={lex.xp} col="tokens" sort={sort} onSort={onSort} align="right" />
            <Th label={lex.gil} col="cost" sort={sort} onSort={onSort} align="right" />
            <span className="th">{lex.facet.fate}</span>
            <span className="th" />
          </div>
          {groups.map((g) => (
            <div key={g.label || "all"} style={{ display: "contents" }}>
              {g.label && <div className="day-head">{g.label} <span className="ct">{g.rows.length}</span></div>}
              {g.rows.map((s) => <Row key={s.sessionKey} s={s} now={now} lex={lex} onOpen={onOpen} />)}
            </div>
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="pager">
          <button className="cmd" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>◀ prev</button>
          <span>page {page + 1} / {pages}</span>
          <button className="cmd" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>next ▶</button>
        </div>
      )}
    </div>
  );
}
