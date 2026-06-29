import { useCallback, useEffect, useRef, useState } from "react";
import type { HostReport, TemplateWithXp, SpawnRequest, TmuxWindow, ItermTab } from "@mc/shared";
import { classOf, gold } from "./rpg.ts";
import { fmtTokens } from "./format.ts";
import { useQuests } from "./useQuery.ts";

const PROVIDERS = ["claude", "codex", "opencode", "pi", "hermes", "openclaw"] as const;
const POLL_MS = 5000;

/** A connected host (id + label + its live tmux windows / iTerm tabs) for the deploy picker. */
type Host = { hostId: string; hostLabel: string; windows?: TmuxWindow[]; itermTabs?: ItermTab[] };

/** Editor form state — args kept as a raw text field, split on save. */
type Backend = "iterm2" | "tmux";
type TemplateDraft = { id?: string; name: string; provider: string; args: string; prompt: string; cwd: string; backend: Backend };

const EMPTY_DRAFT: TemplateDraft = { name: "", provider: "claude", args: "", prompt: "", cwd: "", backend: "iterm2" };

/**
 * Split a free-form args string into argv tokens. Whitespace outside quotes
 * separates tokens; single- or double-quoted spans (anywhere within a token,
 * e.g. `--flag="a b"`) are kept intact and their surrounding quote chars stripped.
 */
export function parseArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inTok = false;
  let quote: '"' | "'" | null = null;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; inTok = true; continue; }
    if (/\s/.test(ch)) {
      if (inTok) { out.push(cur); cur = ""; inTok = false; }
      continue;
    }
    cur += ch;
    inTok = true;
  }
  if (inTok) out.push(cur);
  return out;
}

async function fetchTemplates(): Promise<TemplateWithXp[]> {
  const r = await fetch("/api/templates");
  if (!r.ok) throw new Error(`templates ${r.status}`);
  return (await r.json()) as TemplateWithXp[];
}

/** One template card + its inline deploy form. Mirrors the .char card look. */
function TemplateCard({ lord, hosts, onDeploy, onEdit, onDelete }: {
  lord: TemplateWithXp;
  hosts: Host[];
  onDeploy: (req: SpawnRequest) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const cls = classOf(lord.provider);
  const [open, setOpen] = useState(false);
  const single = hosts.length === 1;
  const [hostId, setHostId] = useState(hosts[0]?.hostId ?? "");
  const [cwd, setCwd] = useState(lord.cwd ?? "");
  const [windowId, setWindowId] = useState("");
  const [promptOverride, setPromptOverride] = useState("");
  const [questIds, setQuestIds] = useState<string[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // this lord's unstarted quests — selectable to fold into the marching orders on deploy
  const lordQuests = useQuests({ templateId: lord.id, status: "pending" });

  // keep the host preselected as the connected set changes
  useEffect(() => {
    if (!hostId && hosts[0]) setHostId(hosts[0].hostId);
  }, [hosts, hostId]);

  // clear any pending flash timer on unmount
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // existing deploy targets on the chosen host — iTerm tabs for iterm2 templates,
  // tmux windows for tmux templates. Picking one splits it; blank = new/spiral.
  const targetId = single ? hosts[0]?.hostId : hostId;
  const host = hosts.find((h) => h.hostId === targetId);
  const isIterm = (lord.backend ?? "iterm2") === "iterm2";
  const targets: { value: string; label: string }[] = isIterm
    ? (host?.itermTabs ?? []).map((t) => ({ value: t.sessionId, label: t.title || "(untitled tab)" }))
    : (host?.windows ?? []).map((w) => ({ value: w.id, label: `${w.session}:${w.name || "(unnamed)"} (${w.id})` }));

  const deploy = () => {
    const target = single ? hosts[0]?.hostId : hostId;
    if (!target) return;
    const req: SpawnRequest = { type: "spawn", hostId: target, templateId: lord.id };
    if (cwd.trim()) req.cwd = cwd.trim();
    if (windowId.trim()) req.windowId = windowId.trim();
    if (promptOverride.trim()) req.promptOverride = promptOverride.trim();
    if (questIds.length) req.questIds = questIds;
    onDeploy(req);
    setOpen(false);
    setPromptOverride("");
    setWindowId("");
    setQuestIds([]);
    setTimeout(() => lordQuests.refetch(), 800); // selected quests flip to in_progress server-side
    // spawn has no synchronous ack — the troop shows on the board a tick later.
    const label = hosts.find((h) => h.hostId === target)?.hostLabel ?? target;
    setFlash(`Deploying to ${label}…`);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2500);
  };

  return (
    <article className="win char lord" style={{ ["--hue" as any]: cls.hue }}>
      <header className="char-head">
        <span className="portrait" title={cls.job}>{cls.sigil}</span>
        <span className="char-id">
          <h3 className="char-name">{lord.name}</h3>
          <span className="char-class"><b>{cls.job}</b> · {lord.provider}</span>
        </span>
        <span className="char-lv">Lv<b>{lord.level}</b></span>
      </header>

      <div className="lord-stats">
        <span className="lstat" title="sessions spawned">⚑ {lord.troopsDeployed} deploys</span>
        <span className="lstat" title="lifetime tokens">◇ {fmtTokens(lord.totalTokens)}</span>
        <span className="lstat gil" title="gil (lifetime cost)">⛁ {gold(lord.totalCost)}</span>
      </div>

      {!open && (
        <>
          {flash && <div className="lord-flash">⚑ {flash}</div>}
          <div className="char-actions">
            <button className="cmd go" style={{ flex: 1 }} onClick={() => setOpen(true)} title="deploy a new troop">⚔ Deploy</button>
            <button className="cmd" onClick={onEdit} title="edit template">✎</button>
            <button className="cmd danger" onClick={onDelete} title="delete template">🗑</button>
          </div>
        </>
      )}

      {open && (
        <div className="lord-deploy">
          {!single && (
            <div className="field">
              <label>Realm (host)</label>
              <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
                {hosts.length === 0 && <option value="">no realms connected</option>}
                {hosts.map((h) => <option key={h.hostId} value={h.hostId}>{h.hostLabel}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label>Working directory</label>
            <input type="text" value={cwd} placeholder={lord.cwd ?? "(provider default)"} onChange={(e) => setCwd(e.target.value)} />
          </div>
          <div className="field">
            <label>{isIterm ? "iTerm tab" : "Quest window"} <span className="hint">(where the troop lands)</span></label>
            <select value={windowId} onChange={(e) => setWindowId(e.target.value)}>
              <option value="">{isIterm ? "＋ New / next split" : "＋ New window"}</option>
              {targets.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Marching orders <span className="hint">(overrides template prompt)</span></label>
            <textarea value={promptOverride} placeholder={lord.prompt ?? "(use template prompt)"} onChange={(e) => setPromptOverride(e.target.value)} />
          </div>
          {lordQuests.data.length > 0 && (
            <div className="field">
              <label>Quests <span className="hint">(folded into orders)</span></label>
              <div className="quest-pick">
                {lordQuests.data.map((q) => {
                  const on = questIds.includes(q.id);
                  return (
                    <button key={q.id} type="button" className="chip" aria-pressed={on}
                      onClick={() => setQuestIds((ids) => on ? ids.filter((x) => x !== q.id) : [...ids, q.id])}>
                      {on ? "✓ " : "＋ "}{q.subject}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="char-actions">
            <button className="cmd go" style={{ flex: 1 }} onClick={deploy} disabled={!single && !hostId} title="deploy">▶ Send forth</button>
            <button className="cmd" onClick={() => setOpen(false)} title="cancel">✕</button>
          </div>
        </div>
      )}
    </article>
  );
}

/** Create/edit template drawer. Writes are public (same trust model as the rest of the API). */
function TemplateEditor({ draft, onClose, onSaved }: {
  draft: TemplateDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!draft.id;
  const [d, setD] = useState<TemplateDraft>(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof TemplateDraft, v: string) => setD((p) => ({ ...p, [k]: v }));

  // guard async setState after the drawer closes/unmounts
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const jsonHeaders = { "content-type": "application/json" };

  const surface = async (r: Response): Promise<boolean> => {
    if (!r.ok) {
      let msg = `request failed (${r.status})`;
      try { const j = await r.json(); if (j?.error) msg = String(j.error); } catch { /* ignore */ }
      if (alive.current) setError(msg);
      return false;
    }
    return true;
  };

  const save = async () => {
    if (!d.name.trim()) { setError("Name is required."); return; }
    setBusy(true); setError(null);
    const body = JSON.stringify({
      name: d.name.trim(),
      provider: d.provider.trim(),
      args: parseArgs(d.args),
      prompt: d.prompt.trim() || undefined,
      cwd: d.cwd.trim() || undefined,
      backend: d.backend,
    });
    try {
      const r = editing
        ? await fetch(`/api/templates/${encodeURIComponent(d.id!)}`, { method: "PATCH", headers: jsonHeaders, body })
        : await fetch("/api/templates", { method: "POST", headers: jsonHeaders, body });
      if (await surface(r)) { onSaved(); onClose(); }
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const remove = async () => {
    if (!d.id) return;
    if (!confirm(`Delete template "${d.name}"? It will no longer appear in the roster.`)) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/templates/${encodeURIComponent(d.id)}`, { method: "DELETE", headers: jsonHeaders });
      if (await surface(r)) { onSaved(); onClose(); }
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="win drawer" onClick={(e) => e.stopPropagation()}>
        <h3>{editing ? "✎ Edit Template" : "✦ New Template"}</h3>

        <div className="field">
          <label>Name</label>
          <input type="text" value={d.name} placeholder="e.g. Code Review Template" onChange={(e) => set("name", e.target.value)} />
        </div>
        <div className="field">
          <label>Provider (class)</label>
          <select value={d.provider} onChange={(e) => set("provider", e.target.value)}>
            {PROVIDERS.map((p) => <option key={p} value={p}>{p} — {classOf(p).job}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Terminal <span className="hint">(where troops open)</span></label>
          <select value={d.backend} onChange={(e) => setD((p) => ({ ...p, backend: e.target.value as Backend }))}>
            <option value="iterm2">iTerm2 native panes</option>
            <option value="tmux">tmux (persistent / remote)</option>
          </select>
        </div>
        <div className="field">
          <label>Args <span className="hint">(space-separated)</span></label>
          <input type="text" value={d.args} placeholder="--model opus --dangerously-skip-permissions" onChange={(e) => set("args", e.target.value)} />
        </div>
        <div className="field">
          <label>Working directory <span className="hint">(optional)</span></label>
          <input type="text" value={d.cwd} placeholder="/path/to/project" onChange={(e) => set("cwd", e.target.value)} />
        </div>
        <div className="field">
          <label>Prompt <span className="hint">(optional)</span></label>
          <textarea value={d.prompt} placeholder="Standing orders for every troop this template deploys…" onChange={(e) => set("prompt", e.target.value)} />
        </div>

        {error && <div className="lord-err">⚠ {error}</div>}

        <div className="char-actions">
          <button className="cmd go" style={{ flex: 1 }} onClick={save} disabled={busy} title="save">
            {busy ? "…" : editing ? "Save" : "Create"}
          </button>
          {editing && <button className="cmd danger" onClick={remove} disabled={busy} title="delete">🗑</button>}
          <button className="cmd" onClick={onClose} disabled={busy} title="cancel">✕</button>
        </div>
      </aside>
    </div>
  );
}

/** Roster of templates (spawn templates) with deploy + editor. */
export function TemplatesBar({ hosts, spawn }: { hosts: Host[]; spawn: (req: SpawnRequest) => void }) {
  const [templates, setTemplates] = useState<TemplateWithXp[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [editor, setEditor] = useState<TemplateDraft | null>(null);

  // Guard against unmount + out-of-order responses: only the newest request
  // (highest seq) may apply, so an overlapping poll / after-save refresh can't
  // resurrect stale data (e.g. a just-deleted template).
  const alive = useRef(true);
  const seq = useRef(0);
  const refresh = useCallback(() => {
    const mine = ++seq.current;
    fetchTemplates()
      .then((data) => { if (alive.current && mine === seq.current) setTemplates(data); })
      .catch(() => { /* best-effort; keep last roster */ });
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => { alive.current = false; clearInterval(id); };
  }, [refresh]);

  const onDelete = useCallback(async (lord: TemplateWithXp) => {
    if (!confirm(`Delete template "${lord.name}"?`)) return;
    try {
      const r = await fetch(`/api/templates/${encodeURIComponent(lord.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      });
      if (r.ok) refresh();
    } catch { /* best-effort */ }
  }, [refresh]);

  return (
    <section className="lords">
      <div className="realm-head">
        Templates
        <span className="ct">{templates.length} {templates.length === 1 ? "template" : "templates"}</span>
        <span style={{ flex: 1 }} />
        <button className="cmd" onClick={() => setEditor({ ...EMPTY_DRAFT })} title="create a new template">＋ New Template</button>
        <button className="cmd" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "show" : "hide"}>
          {collapsed ? "▸" : "▾"}
        </button>
      </div>

      {!collapsed && (
        <div className="lords-grid">
          {templates.length === 0 && (
            <div className="lords-empty">No templates yet. Create one to deploy agents on demand.</div>
          )}
          {templates.map((lord) => (
            <TemplateCard
              key={lord.id}
              lord={lord}
              hosts={hosts}
              onDeploy={spawn}
              onEdit={() => setEditor({
                id: lord.id, name: lord.name, provider: lord.provider,
                args: (lord.args ?? []).join(" "), prompt: lord.prompt ?? "", cwd: lord.cwd ?? "",
                backend: (lord.backend as Backend) ?? "iterm2",
              })}
              onDelete={() => onDelete(lord)}
            />
          ))}
        </div>
      )}

      {editor && (
        <TemplateEditor draft={editor} onClose={() => setEditor(null)} onSaved={refresh} />
      )}
    </section>
  );
}
