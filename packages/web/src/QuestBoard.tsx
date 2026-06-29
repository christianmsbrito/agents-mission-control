import { useState } from "react";
import type { Session, QuestView, QuestStatus } from "@mc/shared";
import { useQuests, useTemplates, createQuest, updateQuest, deleteQuest } from "./useQuery.ts";
import { classOf, charName, liveKey } from "./rpg.ts";
import { useLex, type Lexicon } from "./lexicon.ts";

function cols(lex: Lexicon): { key: QuestStatus; label: string; icon: string }[] {
  return [
    { key: "in_progress", label: lex.questBoard.active, icon: "▸" },
    { key: "pending", label: lex.questBoard.backlog, icon: "○" },
    { key: "completed", label: lex.questBoard.done, icon: "✔" },
  ];
}

function Owner({ q }: { q: QuestView }) {
  const sig = q.provider ? classOf(q.provider).sigil : "◆";
  if (q.templateId)
    return <span className="qwho"><span className="sig">{sig}</span>{q.templateName ?? "lord"} <span className="qtag">lord</span></span>;
  if (q.sessionKey)
    return <span className="qwho"><span className="sig">{sig}</span>{q.sessionDisplayName ?? "agent"}{q.hostLabel ? ` · ${q.hostLabel}` : ""}</span>;
  return <span className="qwho muted">unassigned</span>;
}

function QCard({ q, onMutate }: { q: QuestView; onMutate: () => void }) {
  const set = async (status: QuestStatus) => { await updateQuest(q.id, { status }); onMutate(); };
  const del = async () => { await deleteQuest(q.id); onMutate(); };
  return (
    <div className="qcard">
      <span className="qsub">{q.subject}</span>
      {q.body && <span className="qbody">{q.body}</span>}
      <Owner q={q} />
      <div className="qactions">
        {q.status !== "in_progress" && <button className="cmd" title="start" onClick={() => set("in_progress")}>▸</button>}
        {q.status !== "completed" && <button className="cmd" title="complete" onClick={() => set("completed")}>✓</button>}
        {q.status === "completed" && <button className="cmd" title="reopen" onClick={() => set("pending")}>↩</button>}
        <button className="cmd danger" title="delete" onClick={del}>✕</button>
      </div>
    </div>
  );
}

function Composer({ all, onClose, onCreated }: { all: Session[]; onClose: () => void; onCreated: () => void }) {
  const lex = useLex();
  const templates = useTemplates();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<"lord" | "agent" | "none">("lord");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const lords = templates.data;
  const agents = all;

  const submit = async () => {
    const s = subject.trim();
    if (!s || busy) return;
    setBusy(true);
    try {
      await createQuest({
        subject: s,
        body: body.trim() || undefined,
        templateId: mode === "lord" && target ? target : undefined,
        sessionKey: mode === "agent" && target ? target : undefined,
      });
      onCreated();
      onClose();
    } finally { setBusy(false); }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="win sheet" style={{ width: "min(520px, 100%)" }} onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn close-x" onClick={onClose}>✕</button>
        <div className="sheet-name" style={{ fontSize: 16 }}>＋ New {lex.quest}</div>
        <div className="field" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <label>Subject</label>
          <input type="text" autoFocus value={subject} placeholder={`what should this ${lex.hero} do?`}
            onChange={(e) => setSubject(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
        </div>
        <div className="field" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <label>Details <span className="muted">(optional)</span></label>
          <textarea rows={3} value={body} placeholder="extra context / marching orders" onChange={(e) => setBody(e.target.value)} />
        </div>
        <div className="field" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <label>Assign to</label>
          <div className="seg">
            <button aria-pressed={mode === "lord"} onClick={() => { setMode("lord"); setTarget(""); }}>a lord</button>
            <button aria-pressed={mode === "agent"} onClick={() => { setMode("agent"); setTarget(""); }}>a running {lex.hero}</button>
            <button aria-pressed={mode === "none"} onClick={() => { setMode("none"); setTarget(""); }}>unassigned</button>
          </div>
        </div>
        {mode === "lord" && (
          <div className="field" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <label>Lord</label>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">— pick a lord —</option>
              {lords.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.provider})</option>)}
            </select>
          </div>
        )}
        {mode === "agent" && (
          <div className="field" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <label>Running {lex.hero}</label>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">— pick a {lex.hero} —</option>
              {agents.map((s) => <option key={s.id} value={liveKey(s)}>{charName(s)} · {s.category} · {s.hostLabel}</option>)}
            </select>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="cmd" onClick={onClose}>cancel</button>
          <button className="cmd go" disabled={!subject.trim() || busy} onClick={submit}>assign ▶</button>
        </div>
      </div>
    </div>
  );
}

export function QuestBoard({ all }: { all: Session[] }) {
  const lex = useLex();
  const { data, loading, refetch } = useQuests();
  const [composing, setComposing] = useState(false);
  const active = data.filter((q) => q.status !== "cancelled");

  return (
    <div className="scroll">
      <div className="rec-toolbar">
        <button className="cmd go" onClick={() => setComposing(true)}>＋ New {lex.quest}</button>
        <span className="rec-count">{loading ? "…" : `${active.length} ${active.length === 1 ? lex.quest : lex.quests}`}</span>
      </div>

      {!loading && active.length === 0 && (
        <div className="empty"><span className="crest">⚑</span><span className="big">{lex.questBoard.empty}</span>
          <span>Assign one to a lord or a running {lex.hero} with ＋ New {lex.quest}.</span></div>
      )}

      {active.length > 0 && (
        <div className="kanban">
          {cols(lex).map((c) => {
            const rows = active.filter((q) => q.status === c.key);
            return (
              <div className="win column" data-c={c.key} key={c.key}>
                <div className="cap">{c.icon} {c.label}<span className="n">{rows.length}</span></div>
                {rows.length === 0 && <span style={{ color: "var(--ink-faint)", fontSize: 12 }}>—</span>}
                {rows.map((q) => <QCard key={q.id} q={q} onMutate={refetch} />)}
              </div>
            );
          })}
        </div>
      )}

      {composing && <Composer all={all} onClose={() => setComposing(false)} onCreated={refetch} />}
    </div>
  );
}
