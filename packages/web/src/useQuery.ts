import { useCallback, useEffect, useState } from "react";
import type { WorkItem, Quest, QuestView, QuestStatus, TemplateWithXp } from "@mc/shared";

// Hooks for the query-plane endpoints added in the backend UI-readiness phase:
// /api/facets, /api/stats/timeseries, /api/quests. All plain fetch, abort-on-change.

export type FacetBucket = { value: string; count: number; label?: string };
export type Facets = { providers: FacetBucket[]; categories: FacetBucket[]; hosts: FacetBucket[]; states: FacetBucket[] };

export type TimeseriesPoint = { t: number; value: number };
export type TimeseriesSeries = { key: string; points: TimeseriesPoint[] };
export type TimeseriesResponse = { bucket: "hour" | "day"; metric: "cost" | "tokens"; series: TimeseriesSeries[] };


function useJson<T>(url: string | null, fallback: T): { data: T; loading: boolean; error: string | null; refetch: () => void } {
  const [state, setState] = useState<{ data: T; loading: boolean; error: string | null }>({
    data: fallback, loading: url !== null, error: null,
  });
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (url === null) return;
    let alive = true;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch(url, { signal: ctrl.signal })
      .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return (await r.json()) as T; })
      .then((data) => { if (alive) setState({ data, loading: false, error: null }); })
      .catch((e) => { if (alive && e.name !== "AbortError") setState({ data: fallback, loading: false, error: String(e?.message ?? e) }); });
    return () => { alive = false; ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, nonce]);
  return { ...state, refetch };
}

const EMPTY_FACETS: Facets = { providers: [], categories: [], hosts: [], states: [] };

export function useFacets(qs: string) {
  return useJson<Facets>(`/api/facets${qs ? `?${qs}` : ""}`, EMPTY_FACETS);
}

export function useTimeseries(opts: {
  since: number; until: number; bucket?: "hour" | "day"; metric?: "cost" | "tokens"; groupBy?: string;
}) {
  const p = new URLSearchParams();
  p.set("since", String(opts.since));
  p.set("until", String(opts.until));
  if (opts.bucket) p.set("bucket", opts.bucket);
  if (opts.metric) p.set("metric", opts.metric);
  if (opts.groupBy) p.set("groupBy", opts.groupBy);
  return useJson<TimeseriesResponse>(`/api/stats/timeseries?${p.toString()}`, {
    bucket: opts.bucket ?? "day", metric: opts.metric ?? "cost", series: [],
  });
}

/** Managed quests (user-assigned). Filter by status / templateId / sessionKey. */
export function useQuests(filter: { status?: string; templateId?: string; sessionKey?: string } = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v) p.set(k, String(v));
  const qs = p.toString();
  return useJson<QuestView[]>(`/api/quests${qs ? `?${qs}` : ""}`, []);
}

/** Active spawn templates ("lords"). */
export function useTemplates() {
  return useJson<TemplateWithXp[]>("/api/templates", []);
}

/** The agent's own TodoWrite work items for a session (drill-down). */
export function useSessionQuests(key: string | null) {
  return useJson<WorkItem[]>(key ? `/api/sessions/${encodeURIComponent(key)}/quests` : null, []);
}

// --- managed-quest mutations (public, fire-and-await; caller refetches) ---
export async function createQuest(input: { subject: string; body?: string; templateId?: string; sessionKey?: string }): Promise<Quest> {
  const r = await fetch("/api/quests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
export async function updateQuest(id: string, patch: { subject?: string; body?: string; status?: QuestStatus; templateId?: string | null; sessionKey?: string | null }): Promise<void> {
  await fetch(`/api/quests/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
}
export async function deleteQuest(id: string): Promise<void> {
  await fetch(`/api/quests/${encodeURIComponent(id)}`, { method: "DELETE" });
}
