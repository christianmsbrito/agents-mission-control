import { useState, useRef, useLayoutEffect, type MouseEvent } from "react";
import type { Session } from "@mc/shared";
import { classOf, levelOf, levelProgress, hpOf, battleStateOf, charName, gold, classifyCrash, subSplit, subTokens } from "./rpg.ts";
import { fmtTokens, fmtAgo, fmtUptime, fmtCost } from "./format.ts";
import type { SubSession } from "@mc/shared";
import { useLex } from "./lexicon.ts";

function Bar({ kind, label, pct, value, low }: { kind: "hp" | "mp"; label: string; pct: number; value: string; low?: boolean }) {
  return (
    <div className="bar">
      <span className="blab">{label}</span>
      <span className="track">
        <span className={`fill ${kind}${low ? " low" : ""}`} style={{ width: `${Math.round(pct * 100)}%` }} />
      </span>
      <span className="val">{value}</span>
    </div>
  );
}

/** One subagent row in the expandable list. Click-to-expand into a small detail
 * block (in/out/cache tokens, peak context, model, duration). Mirrors the
 * TemplateCard `open`-state inline-expand pattern. */
function SubagentRow({ sub }: { sub: SubSession }) {
  const [open, setOpen] = useState(false);
  const label = sub.kind || sub.agentId.slice(0, 8);
  const dur = sub.firstAt != null && sub.lastAt != null && sub.lastAt > sub.firstAt
    ? fmtUptime(sub.firstAt, sub.lastAt) : null;
  return (
    <div className="subrow" data-open={open || undefined}>
      <button className="subrow-head" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        <span className="tw">{open ? "▾" : "▸"}</span>
        <span className="nm" title={sub.agentId}>{label}</span>
        <span className="c gil">{fmtCost(sub.costUsd)}</span>
        <span className="c tok">{fmtTokens(subTokens(sub))}</span>
        <span className="c tools" title={(sub.toolsUsed ?? []).join(", ")}>
          {(sub.toolsUsed ?? []).slice(0, 3).join(", ") || "—"}
          {(sub.toolsUsed?.length ?? 0) > 3 ? ` +${sub.toolsUsed!.length - 3}` : ""}
        </span>
      </button>
      {open && (
        <div className="subrow-detail">
          <span>in {fmtTokens(sub.tokensIn)} · out {fmtTokens(sub.tokensOut)} · cache {fmtTokens((sub.tokensCacheRead ?? 0) + (sub.tokensCacheWrite ?? 0))}</span>
          <span>
            {sub.peakContextTokens != null && `peak ctx ${fmtTokens(sub.peakContextTokens)}`}
            {sub.model && ` · ${sub.model.replace(/^claude-|-\d.*$/g, "")}`}
            {dur && ` · ${dur}`}
          </span>
        </div>
      )}
    </div>
  );
}

/** Collapsed "▸ N subagents · $Y (Z%)  main $X" row that expands into the list. */
function SubagentList({ s }: { s: Session }) {
  const [open, setOpen] = useState(false);
  const subs = s.subSessions ?? [];
  if (subs.length === 0) return null;
  const { subCount, subCost, mainCost, subPct } = subSplit(s);
  return (
    <div className="subs" data-open={open || undefined}>
      <button className="subs-head" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        <span className="tw">{open ? "▾" : "▸"}</span>
        <span className="lbl">{subCount} subagent{subCount === 1 ? "" : "s"} · {fmtCost(subCost)} ({subPct}%)</span>
        <span className="main">main {fmtCost(mainCost)}</span>
      </button>
      {open && (
        <div className="subs-list">
          {subs.map((sub) => <SubagentRow key={sub.agentId} sub={sub} />)}
        </div>
      )}
    </div>
  );
}

export function CharacterCard({
  s, now, compact, showCost, onOpen, onFocus, onKill, onPrompt,
}: {
  s: Session;
  now: number;
  compact: boolean;
  showCost: boolean;
  onOpen: () => void;
  onFocus: () => void;
  onKill: () => void;
  onPrompt: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const lex = useLex();
  const cls = classOf(s.provider);
  const job = lex.jobs[s.provider] ?? lex.jobFallback;
  const level = levelOf(s);
  const hp = hpOf(s.contextTokens, s.contextWindow);
  const state = battleStateOf(s);
  const items = s.workItems ?? [];
  const activeQuest = items.find((i) => i.status === "in_progress") ?? items.find((i) => i.status === "pending");
  const questText = activeQuest?.subject ?? s.subject;
  const remaining = items.filter((i) => i.status !== "completed").length;

  const send = () => {
    const t = draft.trim();
    if (!t) return;
    onPrompt(t);
    setDraft("");
  };

  // Click the nickname to copy this hero's A2A routing handle (`mc:a<n>`, the exact
  // token the server's router accepts) so it can be pasted to address the agent.
  // stopPropagation so it doesn't also fire the .char-id onOpen (sheet drawer).
  const [copied, setCopied] = useState(false);
  const copyAlias = (e: MouseEvent) => {
    if (!s.handle) return;
    e.stopPropagation();
    try {
      navigator.clipboard?.writeText(s.handle);
      setCopied(true);
      setTimeout(() => setCopied(false), 1100);
    } catch { /* clipboard can reject (e.g. insecure context) — fail silently */ }
  };

  // Glanceable top-right "chat balloon": the most recent meaningful signal the
  // hero would say out loud. Precedence: warning (errored) > follow-up question
  // (awaiting input) > last action (recap). Idle/running-without-recap stays silent.
  // Errored: describe the crash (the parsed crashReason, else the recap, else the
  // generic KO label) and append a suggested action item derived honestly from the
  // crash text/transience. Once TASK-11's fix clears `errored` on recovery, the
  // reporter stops emitting errored/crashReason, this branch is no longer taken,
  // and the balloon falls through to ask/say — no stale crash message lingers.
  const crashDesc = s.crashReason ?? s.summary ?? lex.state.ko;
  const crashAction = lex.crash[classifyCrash(s.crashReason, s.errorTransient)];
  const balloon: { kind: "warn" | "ask" | "say"; glyph: string; text: string } | null =
    s.errored ? { kind: "warn", glyph: "⚠", text: [crashDesc, crashAction].filter(Boolean).join(" — ") }
    : (state === "awaiting" && s.ask) ? { kind: "ask", glyph: "❓", text: s.ask }
    : s.summary ? { kind: "say", glyph: "💬", text: s.summary }
    : null;

  // The balloon "rolls" (gentle marquee) only when the text actually overflows the
  // fixed-width bubble. We measure scrollWidth vs clientWidth on the inner text span
  // and gate the CSS animation with a data-overflow attr; the scroll distance + a
  // length-scaled duration are passed as CSS vars so long messages roll slowly/readably.
  // Click (or tap) toggles a full expanded view; hover does the same via CSS (:hover).
  const speechRef = useRef<HTMLDivElement>(null);
  const txtRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const el = speechRef.current, txt = txtRef.current;
    if (!el || !txt) return;
    const overflow = txt.scrollWidth - txt.clientWidth;
    if (overflow > 2) {
      el.dataset.overflow = "true";
      el.style.setProperty("--roll", `${overflow}px`);
      // Scale the loop duration with text length so long messages roll slowly/readably
      // (the keyframes pause ~12% at each end, so effective travel speed is gentle).
      // min ~12s keeps short overflows from twitching.
      const dur = Math.max(12, Math.round(overflow / 11));
      el.style.setProperty("--roll-dur", `${dur}s`);
    } else {
      delete el.dataset.overflow;
    }
  }, [balloon?.text]);
  const toggleExpand = (e: MouseEvent) => {
    e.stopPropagation(); // don't bubble to .char-id onOpen (sheet drawer)
    setExpanded((v) => !v);
  };

  return (
    <article className="win char" data-state={state} data-focused={s.focused || undefined} style={{ ["--hue" as any]: cls.hue }}>
      {balloon && (
        <div
          ref={speechRef}
          className="speech"
          data-kind={balloon.kind}
          data-expanded={expanded || undefined}
          title={balloon.text}
          onClick={toggleExpand}
        >
          <span className="sglyph">{balloon.glyph}</span>
          <span ref={txtRef} className="stxt"><span className="sroll">{balloon.text}</span></span>
        </div>
      )}
      <header className="char-head">
        <span className="portrait" title={job}>{cls.sigil}</span>
        <span className="char-id" onClick={onOpen} style={{ cursor: "pointer" }}>
          <h3 className="char-name">
            {s.focused && <span className="crown" title="in foreground">♔</span>}
            {charName(s)}
            {s.handle && (
              <span
                className="alias-copy"
                data-copied={copied || undefined}
                title={`Click to copy alias ${s.handle}`}
                onClick={copyAlias}
              >
                {copied ? "✓ copied" : s.handle}
              </span>
            )}
          </h3>
          <span className="char-class"><b>{job}</b> · {s.category}{s.model ? ` · ${s.model.replace(/^claude-|-\d.*$/g, "")}` : ""}</span>
        </span>
        <span className="char-lv">{lex.level}<b>{level}</b></span>
      </header>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span className="tag" data-state={state}>{lex.state[state]}</span>
        <span className="meta">
          {s.active && <span className="pip" title="active now">◉</span>}
          <span>{s.hostLabel}</span>
          <span title="lifespan">·{fmtUptime(s.startedAt, now)}</span>
          <span>·{fmtAgo(s.lastActivityAt ?? s.startedAt, now)}</span>
        </span>
      </div>

      <div className="bars">
        <Bar kind="hp" label={lex.hp} pct={hp} low={hp < 0.25}
          value={s.contextWindow ? `${fmtTokens(s.contextTokens)}/${fmtTokens(s.contextWindow)}` : "—"} />
        <Bar kind="mp" label={lex.xp} pct={levelProgress(s)} value={`${s.toolsUsed?.length ?? 0} ${lex.skills}`} />
      </div>

      <div className={`quest${questText ? "" : " none"}`}>
        <span className="banner">⚑</span>
        <span className="txt">{questText ?? lex.noQuest}</span>
        {remaining > 1 && <span className="more">+{remaining - 1}</span>}
      </div>

      {!compact && (
        <div className="char-foot">
          {showCost && <span className="gil" title={`${lex.gil} (cost)`}>{lex.gilGlyph} {gold(s.costUsd)}</span>}
          {/* "+N" overflow chip lives here (outside the height-capped, clip-overflow
              .inv) so it is never clipped and keeps reporting the true count of
              tools beyond the shown slice. */}
          {(s.toolsUsed?.length ?? 0) > 5 && (
            <span className="item more" title={`${s.toolsUsed!.length - 5} more tools`}>+{s.toolsUsed!.length - 5}</span>
          )}
          <span className="inv">
            {(s.toolsUsed ?? []).slice(0, 5).map((t) => <span className="item" key={t}>{t}</span>)}
          </span>
        </div>
      )}

      {!compact && <SubagentList s={s} />}

      <div className="char-actions">
        <input
          value={draft}
          placeholder={state === "awaiting" && s.suggestion ? s.suggestion : lex.speakPlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
            if (e.key === "Tab" && !draft && s.suggestion) { e.preventDefault(); setDraft(s.suggestion); }
          }}
        />
        <button className="cmd go" onClick={send} title="send prompt">▶</button>
        <button className="cmd" onClick={onFocus} title="focus terminal">👁</button>
        <button className="cmd danger" onClick={onKill} title="dismiss (SIGTERM)">✕</button>
      </div>
    </article>
  );
}
