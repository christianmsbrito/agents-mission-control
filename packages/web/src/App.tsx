import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AppConfig, HostReport, Session } from "@mc/shared";
import { useLive } from "./useLive.ts";
import { type FacetBucket } from "./useQuery.ts";
import { CharacterCard } from "./CharacterCard.tsx";
import { TemplatesBar } from "./TemplatesBar.tsx";
import { Dashboard, LiveStrip } from "./Dashboard.tsx";
import { QuestBoard } from "./QuestBoard.tsx";
import { HallOfRecords } from "./HallOfRecords.tsx";
import { CharacterSheet } from "./CharacterSheet.tsx";
import { FacetBar, type FacetSel } from "./FacetBar.tsx";
import { battleStateOf, liveKey, type BattleState } from "./rpg.ts";
import { isIdle, prefsReducer, loadPrefs, savePrefs, SKINS, type Prefs, type PrefsAction } from "./prefs.ts";
import { LexiconContext, LEXICONS, useLex } from "./lexicon.ts";

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/live`;
const STATE_RANK = { ko: 0, awaiting: 1, battle: 2, resting: 3 } as const;

type View = "party" | "dashboard" | "quests" | "records";

function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

function matchQ(s: Session, q: string): boolean {
  if (!q) return true;
  const hay = [s.provider, s.handle, s.displayName, s.category, s.model, s.hostLabel, s.cwd, s.subject, ...(s.toolsUsed ?? [])]
    .join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
}

/** Derive facet buckets from the live session set (for the Party view). */
function liveFacets(sessions: Session[]) {
  const count = (pick: (s: Session) => string | null | undefined): FacetBucket[] => {
    const m = new Map<string, number>();
    for (const s of sessions) { const v = pick(s); if (v) m.set(v, (m.get(v) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  };
  return {
    providers: count((s) => s.provider),
    categories: count((s) => s.category),
    hosts: count((s) => s.hostId).map((b) => ({ ...b, label: sessions.find((s) => s.hostId === b.value)?.hostLabel })),
  };
}

type Live = ReturnType<typeof useLive>;

function PartyView({ prefs, q, sel, onToggleFacet, stateFilter, onToggleState, onResetStates, now, onOpen, live, all }: {
  prefs: Prefs; q: string; sel: FacetSel; onToggleFacet: (d: keyof FacetSel, v: string) => void;
  stateFilter: Set<BattleState>; onToggleState: (s: BattleState) => void; onResetStates: () => void;
  now: number; onOpen: (key: string) => void; live: Live; all: Session[];
}) {
  const lex = useLex();
  const { focus, kill, prompt } = live;

  const facets = useMemo(() => liveFacets(all), [all]);
  const shown = useMemo(() => {
    let list = all.filter((s) => matchQ(s, q));
    if (sel.provider) list = list.filter((s) => s.provider === sel.provider);
    if (sel.category) list = list.filter((s) => s.category === sel.category);
    if (sel.host) list = list.filter((s) => s.hostId === sel.host);
    if (stateFilter.size > 0) list = list.filter((s) => stateFilter.has(battleStateOf(s)));
    if (prefs.hideIdle) list = list.filter((s) => s.active || !isIdle(s, prefs.minTokens));
    return list.sort((a, b) => {
      const r = STATE_RANK[battleStateOf(a)] - STATE_RANK[battleStateOf(b)];
      if (r) return r;
      let d = 0;
      if (prefs.sort === "cost") d = (b.costUsd ?? 0) - (a.costUsd ?? 0);
      else if (prefs.sort === "started") d = a.startedAt - b.startedAt;
      else d = (b.lastActivityAt ?? b.startedAt) - (a.lastActivityAt ?? a.startedAt);
      // stable final tiebreaker so equal-value cards don't swap positions each patch
      return d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  }, [all, q, sel, stateFilter, prefs]);

  // group by realm (host)
  const realms = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of shown) { const arr = m.get(s.hostLabel) ?? []; arr.push(s); m.set(s.hostLabel, arr); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown]);

  return (
    <>
      <LiveStrip sessions={all} filter={stateFilter} onToggleState={onToggleState} onResetStates={onResetStates} />
      <div className="cmdbar" style={{ marginBottom: 2 }}>
        <FacetBar facets={facets} sel={sel} onToggle={onToggleFacet} />
      </div>
      <div className="scroll">
        <div className={`party${prefs.density === "compact" ? " compact" : ""}`}>
          {shown.length === 0 && (
            <div className="empty"><span className="crest">⚔</span><span className="big">{lex.partyRestsTitle}</span>
              <span>{all.length === 0 ? lex.partyRestsNone : lex.partyRestsFiltered}</span></div>
          )}
          {realms.map(([realm, list]) => (
            <div key={realm} style={{ display: "contents" }}>
              <div className="realm-head">{realm} <span className="ct">{list.length} {list.length === 1 ? lex.hero : lex.heroes}</span></div>
              {list.map((s) => (
                <CharacterCard
                  key={s.id} s={s} now={now} compact={prefs.density === "compact"} showCost={prefs.showCost}
                  onOpen={() => onOpen(liveKey(s))}
                  onFocus={() => focus(s.id)}
                  onKill={() => { if (confirm(`Dismiss ${s.displayName ?? s.id}? This sends SIGTERM.`)) kill(s.id); }}
                  onPrompt={(t) => prompt(s.id, t)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** Number input with a local draft that commits on blur/Enter (guards NaN). */
function NumField({ value, min, step, onCommit, suffix }: {
  value: number; min?: number; step?: number; onCommit: (n: number) => void; suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => { const n = Number(draft); if (Number.isFinite(n)) onCommit(Math.max(min ?? -Infinity, n)); else setDraft(String(value)); };
  return (
    <span className="numfield">
      <input type="number" value={draft} min={min} step={step}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      {suffix && <span className="suf">{suffix}</span>}
    </span>
  );
}

type Row = { id: number; a: string; b: string };

function Settings({ prefs, dispatch, config, onSave, onClose }: {
  prefs: Prefs; dispatch: React.Dispatch<PrefsAction>;
  config: AppConfig | null; onSave: (patch: Partial<AppConfig>) => void; onClose: () => void;
}) {
  const lex = useLex();
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  // Category-rule rows, seeded from server config when the drawer opens (not on
  // every ~3s echo, which would clobber in-progress edits). Stable ids for keys.
  const rid = useRef(0);
  const next = () => rid.current++;
  const [provRows, setProvRows] = useState<Row[]>([]);
  const [cwdRows, setCwdRows] = useState<Row[]>([]);
  useEffect(() => {
    if (!config) return;
    setProvRows(Object.entries(config.categories.byProvider ?? {}).map(([a, b]) => ({ id: next(), a, b })));
    setCwdRows((config.categories.byCwd ?? []).map((r) => ({ id: next(), a: r.match, b: r.category })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveProv = (rows: Row[]) => {
    if (!config) return;
    const byProvider: Record<string, string> = {};
    for (const r of rows) if (r.a.trim()) byProvider[r.a.trim()] = r.b.trim();
    onSave({ categories: { ...config.categories, byProvider } });
  };
  const saveCwd = (rows: Row[]) => {
    if (!config) return;
    const byCwd = rows.map((r) => ({ match: r.a.trim(), category: r.b.trim() })).filter((r) => r.match);
    onSave({ categories: { ...config.categories, byCwd } });
  };
  const seconds = (ms: number) => Math.round(ms / 1000);

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="win drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3>⚙ Options</h3><button className="icon-btn" onClick={onClose}>✕</button></div>

        <div className="set-sec">Appearance <small>this browser</small></div>
        <div className="field"><label>Theme</label>
          <div className="seg">{SKINS.map((s) => (
            <button key={s.id} aria-pressed={prefs.skin === s.id} onClick={() => dispatch({ type: "setSkin", value: s.id })}>{s.label}</button>
          ))}</div>
        </div>
        <div className="field"><label>Density</label>
          <div className="seg">{(["comfortable", "compact"] as const).map((d) => (
            <button key={d} aria-pressed={prefs.density === d} onClick={() => dispatch({ type: "setDensity", value: d })}>{d}</button>
          ))}</div>
        </div>
        <div className="field"><label>Sort {lex.nav.party} by</label>
          <div className="seg">{(["activity", "cost", "started"] as const).map((d) => (
            <button key={d} aria-pressed={prefs.sort === d} onClick={() => dispatch({ type: "setSort", value: d })}>{d}</button>
          ))}</div>
        </div>
        <div className="row-toggle"><span>Show {lex.gil} (cost)</span>
          <button className="cmd" aria-pressed={prefs.showCost} onClick={() => dispatch({ type: "toggle", key: "showCost" })}>{prefs.showCost ? "on" : "off"}</button>
        </div>
        <div className="row-toggle"><span>Hide idle {lex.heroes}</span>
          <button className="cmd" aria-pressed={prefs.hideIdle} onClick={() => dispatch({ type: "toggle", key: "hideIdle" })}>{prefs.hideIdle ? "on" : "off"}</button>
        </div>
        <div className="field"><label>Idle token floor</label>
          <NumField value={prefs.minTokens} min={0} step={500} suffix="tokens"
            onCommit={(n) => dispatch({ type: "setMinTokens", value: n })} />
        </div>

        {!config && <div className="set-sec">Server <small>connecting…</small></div>}
        {config && (
          <>
            <div className="set-sec">Server <small>shared with all viewers</small></div>
            <div className="field"><label>Mark host offline after</label>
              <NumField value={seconds(config.staleMs)} min={2} step={1} suffix="s"
                onCommit={(n) => onSave({ staleMs: n * 1000 })} />
            </div>
            <div className="row-toggle"><span>LLM recaps (Haiku)</span>
              <button className="cmd" aria-pressed={config.summaries.enabled}
                onClick={() => onSave({ summaries: { ...config.summaries, enabled: !config.summaries.enabled } })}>
                {config.summaries.enabled ? "on" : "off"}</button>
            </div>
            {config.summaries.enabled && (
              <>
                <div className="field"><label>Recap model</label>
                  <input type="text" defaultValue={config.summaries.model}
                    onBlur={(e) => onSave({ summaries: { ...config.summaries, model: e.target.value.trim() } })} />
                </div>
                <div className="field"><label>Min recap interval</label>
                  <NumField value={seconds(config.summaries.minIntervalMs)} min={5} step={5} suffix="s"
                    onCommit={(n) => onSave({ summaries: { ...config.summaries, minIntervalMs: n * 1000 } })} />
                </div>
              </>
            )}

            <div className="set-sec">Roles <small>cwd / provider → category</small></div>
            <div className="rules">
              {cwdRows.map((r, i) => (
                <div className="rule" key={r.id}>
                  <input placeholder="cwd regex" value={r.a}
                    onChange={(e) => setCwdRows((rs) => rs.map((x) => x.id === r.id ? { ...x, a: e.target.value } : x))}
                    onBlur={() => saveCwd(cwdRows)} />
                  <span className="arr">→</span>
                  <input placeholder="category" value={r.b}
                    onChange={(e) => setCwdRows((rs) => rs.map((x) => x.id === r.id ? { ...x, b: e.target.value } : x))}
                    onBlur={() => saveCwd(cwdRows)} />
                  <button className="cmd danger" onClick={() => { const rs = cwdRows.filter((x) => x.id !== r.id); setCwdRows(rs); saveCwd(rs); }}>✕</button>
                </div>
              ))}
              <button className="cmd" onClick={() => setCwdRows((rs) => [...rs, { id: next(), a: "", b: "" }])}>+ cwd rule</button>
              {provRows.map((r) => (
                <div className="rule" key={r.id}>
                  <input placeholder="provider" value={r.a}
                    onChange={(e) => setProvRows((rs) => rs.map((x) => x.id === r.id ? { ...x, a: e.target.value } : x))}
                    onBlur={() => saveProv(provRows)} />
                  <span className="arr">→</span>
                  <input placeholder="category" value={r.b}
                    onChange={(e) => setProvRows((rs) => rs.map((x) => x.id === r.id ? { ...x, b: e.target.value } : x))}
                    onBlur={() => saveProv(provRows)} />
                  <button className="cmd danger" onClick={() => { const rs = provRows.filter((x) => x.id !== r.id); setProvRows(rs); saveProv(rs); }}>✕</button>
                </div>
              ))}
              <button className="cmd" onClick={() => setProvRows((rs) => [...rs, { id: next(), a: "", b: "" }])}>+ provider rule</button>
            </div>

            <div className="set-sec">Retention <small>history pruning</small></div>
            <div className="field"><label>Keep raw samples</label>
              <NumField value={config.retention.rawDays} min={1} suffix="days"
                onCommit={(n) => onSave({ retention: { ...config.retention, rawDays: n } })} />
            </div>
            <div className="field"><label>Keep hourly samples</label>
              <NumField value={config.retention.hourDays} min={1} suffix="days"
                onCommit={(n) => onSave({ retention: { ...config.retention, hourDays: n } })} />
            </div>
            <div className="field"><label>Keep events</label>
              <NumField value={config.retention.eventDays} min={1} suffix="days"
                onCommit={(n) => onSave({ retention: { ...config.retention, eventDays: n } })} />
            </div>
            <div className="field"><label>DB size ceiling</label>
              <NumField value={Math.round(config.retention.maxBytes / 1e6)} min={10} step={10} suffix="MB"
                onCommit={(n) => onSave({ retention: { ...config.retention, maxBytes: n * 1e6 } })} />
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

export function App() {
  const [prefs, dispatch] = useReducer(prefsReducer, undefined, loadPrefs);
  const [view, setView] = useState<View>("party");
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<FacetSel>({});
  const [stateFilter, setStateFilter] = useState<Set<BattleState>>(new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const now = useNow();
  const live = useLive(WS_URL);
  const all = useMemo(() => [...live.hosts.values()].flatMap((h) => h.sessions), [live.hosts]);

  // Connected realms (hosts) for the deploy picker — id + label, de-duped.
  const hostList = useMemo(
    () => [...live.hosts.values()]
      .map((h: HostReport) => ({ hostId: h.hostId, hostLabel: h.hostLabel, windows: h.tmuxWindows ?? [], itermTabs: h.itermTabs ?? [] }))
      .sort((a, b) => a.hostLabel.localeCompare(b.hostLabel)),
    [live.hosts],
  );

  useEffect(() => { savePrefs(prefs); }, [prefs]);
  useEffect(() => {
    document.documentElement.dataset.skin = prefs.skin;
    document.documentElement.dataset.theme = prefs.theme;
  }, [prefs.skin, prefs.theme]);
  useEffect(() => { const id = setTimeout(() => setQ(query), 250); return () => clearTimeout(id); }, [query]);

  const onToggleFacet = (d: keyof FacetSel, v: string) =>
    setSel((s) => ({ ...s, [d]: s[d] === v ? undefined : v }));
  const onToggleState = (st: BattleState) =>
    setStateFilter((prev) => { const next = new Set(prev); next.has(st) ? next.delete(st) : next.add(st); return next; });
  const onResetStates = () => setStateFilter(new Set());

  const lex = LEXICONS[prefs.skin] ?? LEXICONS.ff;

  return (
    <LexiconContext.Provider value={lex}>
    <div className="app">
      <header className="topbar">
        <span className="brand"><span className="crest">⚔</span> MISSION&nbsp;CONTROL</span>
        <nav className="nav">
          {(["party", "dashboard", "quests", "records"] as View[]).map((v) => (
            <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{lex.nav[v]}</button>
          ))}
        </nav>
        <span className="spacer" />
        <span className="conn" data-s={live.conn} title={`reporter link: ${live.conn}`}><span className="orb" />{live.conn}</span>
        <button className="icon-btn" title="Options" onClick={() => setShowSettings(true)}>⚙</button>
      </header>

      <div className="cmdbar">
        <div className="searchrow">
          <div className="win search">
            <span className="cur">▌</span>
            <input
              value={query}
              placeholder={view === "records" ? lex.archivePlaceholder : lex.seekPlaceholder}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && <button className="icon-btn" onClick={() => setQuery("")} title="clear">✕</button>}
          </div>
        </div>
      </div>

      {view === "party" && (
        <>
          <TemplatesBar hosts={hostList} spawn={live.spawn} />
          <PartyView prefs={prefs} q={q} sel={sel} onToggleFacet={onToggleFacet} stateFilter={stateFilter} onToggleState={onToggleState} onResetStates={onResetStates} now={now} onOpen={setOpenKey} live={live} all={all} />
        </>
      )}
      {view === "dashboard" && <div className="scroll"><Dashboard sessions={all} now={now} /></div>}
      {view === "quests" && <QuestBoard all={all} />}
      {view === "records" && <HallOfRecords q={q} sel={sel} onToggleFacet={onToggleFacet} onClear={() => { setSel({}); setQuery(""); }} now={now} onOpen={setOpenKey} />}

      {openKey && <CharacterSheet sessionKey={openKey} now={now} onClose={() => setOpenKey(null)} />}
      {showSettings && <Settings prefs={prefs} dispatch={dispatch} config={live.config} onSave={live.setSettings} onClose={() => setShowSettings(false)} />}
    </div>
    </LexiconContext.Provider>
  );
}
