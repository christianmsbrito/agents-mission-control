import { useEffect } from "react";
import { useSessionDetail, sparklinePoints } from "./useHistory.ts";
import { useSessionQuests } from "./useQuery.ts";
import { classOf, xpOf, levelOf, charName, gold, type FateState } from "./rpg.ts";
import { fmtCost, fmtTokens, fmtUptime, fmtAgo } from "./format.ts";
import { useLex } from "./lexicon.ts";

const MARK = { completed: "✔", in_progress: "▸", pending: "○" } as const;

function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <span style={{ color: "var(--ink-faint)", fontSize: 11 }}>—</span>;
  return (
    <svg width="100%" height="34" viewBox="0 0 200 34" preserveAspectRatio="none">
      <polyline points={sparklinePoints(values, 200, 34)} fill="none" stroke={color} strokeWidth={2} />
    </svg>
  );
}

export function CharacterSheet({ sessionKey, now, onClose }: { sessionKey: string; now: number; onClose: () => void }) {
  const { detail, samples, loading } = useSessionDetail(sessionKey);
  const quests = useSessionQuests(sessionKey);
  const lex = useLex();

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const s = detail?.session;
  const cls = s ? classOf(s.provider) : null;
  const xp = s ? xpOf(s) : 0;

  // System usage. `s` here is a PersistedSession (not the live Session), so pid/cpu/mem
  // aren't on it directly: pid lives inside liveId (`${hostId}:${pid}`); cpu/mem are only
  // in the time-series samples — use the most recent one. All guarded for absence.
  const pid = s?.liveId?.split(":").pop() || null;
  const lastSample = samples.length ? samples[samples.length - 1] : undefined;
  const cpu = lastSample?.cpu;
  const memMb = lastSample?.memMb;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="win sheet" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn close-x" onClick={onClose}>✕</button>
        {loading && <div className="empty"><span className="big">{lex.sheet.summoning}</span></div>}
        {!loading && !s && <div className="empty"><span className="big">{lex.sheet.notFound}</span></div>}
        {s && cls && (
          <>
            <header className="sheet-head">
              <span className="portrait" style={{ ["--hue" as any]: cls.hue }}>{cls.sigil}</span>
              <div>
                <div className="sheet-name">{charName(s)}</div>
                <div className="sheet-sub">{lex.level}.{levelOf(s)} {lex.jobs[s.provider] ?? lex.jobFallback} · {s.category}{s.model ? ` · ${s.model}` : ""}</div>
              </div>
              <span className="rec"><span className="fate" data-f={s.state}>{lex.fate[s.state as FateState] ?? s.state}</span></span>
            </header>

            {s.subject && <div className="quest"><span className="banner">⚑</span><span className="txt" style={{ whiteSpace: "normal" }}>{s.subject}</span></div>}
            {s.summary && <p style={{ margin: 0, color: "var(--ink-dim)", fontSize: 13 }}>{s.summary}</p>}

            <section>
              <h4>{lex.sheet.attributes}</h4>
              <div className="grid2">
                <div className="kv"><span className="k">{lex.gil}</span><span className="v" style={{ color: "var(--gold)" }}>{lex.gilGlyph} {gold(s.costUsd)} <small style={{ color: "var(--ink-faint)" }}>({fmtCost(s.costUsd)})</small></span></div>
                <div className="kv"><span className="k">{lex.sheet.xpTokens}</span><span className="v">{fmtTokens(xp)}</span></div>
                <div className="kv"><span className="k">Peak context</span><span className="v">{fmtTokens(s.peakContextTokens)}</span></div>
                <div className="kv"><span className="k">{lex.realm[0].toUpperCase() + lex.realm.slice(1)}</span><span className="v">{s.hostLabel}</span></div>
                <div className="kv"><span className="k">Lifespan</span><span className="v">{s.endedAt ? fmtUptime(s.startedAt, s.endedAt) : fmtUptime(s.startedAt, now)}</span></div>
                <div className="kv"><span className="k">Last seen</span><span className="v">{fmtAgo(s.lastSeenAt, now)}</span></div>
                <div className="kv"><span className="k">Cwd</span><span className="v" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{s.cwd ?? "—"}</span></div>
                <div className="kv"><span className="k">Out tokens</span><span className="v">{fmtTokens(s.tokensOut)}</span></div>
                <div className="kv"><span className="k">PID</span><span className="v">{pid ?? "—"}</span></div>
                <div className="kv"><span className="k">CPU</span><span className="v">{cpu != null ? `${cpu.toFixed(0)}%` : "—"}</span></div>
                <div className="kv"><span className="k">Memory</span><span className="v">{memMb != null ? `${memMb}MB` : "—"}</span></div>
                <div className="kv"><span className="k">Host</span><span className="v">{s.hostLabel}</span></div>
              </div>
            </section>

            {quests.data.length > 0 && (
              <section>
                <h4>{lex.sheet.questLog}</h4>
                <div className="questlog">
                  {quests.data.map((q) => (
                    <div className="ql" key={q.itemKey} data-s={q.status}>
                      <span className="mark">{MARK[q.status]}</span>
                      <span>{q.subject}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {samples.length > 1 && (
              <section>
                <h4>{lex.sheet.saga}</h4>
                <div className="grid2">
                  <div><div className="kv"><span className="k">{lex.gil}</span></div><Spark values={samples.map((x) => x.costUsd ?? 0)} color="var(--gold)" /></div>
                  <div><div className="kv"><span className="k">Context</span></div><Spark values={samples.map((x) => x.contextTokens ?? 0)} color="var(--mp)" /></div>
                  <div><div className="kv"><span className="k">CPU</span></div><Spark values={samples.map((x) => x.cpu ?? 0)} color="var(--battle)" /></div>
                  <div><div className="kv"><span className="k">Memory</span></div><Spark values={samples.map((x) => x.memMb ?? 0)} color="var(--hp)" /></div>
                </div>
              </section>
            )}

            {(s.toolsUsed?.length ?? 0) > 0 && (
              <section>
                <h4>{lex.sheet.inventory}</h4>
                <div className="inv">{s.toolsUsed!.map((t) => <span className="item" key={t}>{t}</span>)}</div>
              </section>
            )}

            <section>
              <h4>{lex.sheet.chronicle}</h4>
              <div className="timeline">
                {detail!.events.length === 0 && <span style={{ color: "var(--ink-faint)" }}>{lex.sheet.noDeeds}</span>}
                {detail!.events.slice(0, 40).map((e, i) => (
                  <div className="ev" key={i}>
                    <span className="when">{fmtAgo(e.at, now)}</span>
                    <span className="what"><b>{e.type.replace("session.", "").replace("task.", "")}</b>{e.detail?.tool ? ` · ${e.detail.tool}` : ""}</span>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
