import { useCallback, useEffect, useState } from "react";
import type { PersistedSession, PersistedEvent, SessionSample } from "@mc/shared";

/** Filter accepted by the /api/sessions endpoint (all optional). */
export type HistoryFilter = {
  state?: string;
  provider?: string;
  category?: string;
  cwd?: string;
  host?: string;
  since?: number;
  until?: number;
  minTokens?: number;
  q?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
};

/**
 * Pure: turn a history filter into a URLSearchParams string, omitting
 * undefined / empty-string values and coercing numbers to strings. Key order
 * follows the object's own enumeration so callers/tests are deterministic.
 */
export function historyQueryString(filter: HistoryFilter): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  return params.toString();
}

/**
 * Pure: build an SVG polyline `points` string for a numeric series scaled to
 * a `width`×`height` box. Min maps to the bottom (y=height), max to the top
 * (y=0); a flat series sits on the vertical midline. Dependency-free.
 */
export function sparklinePoints(values: number[], width: number, height: number): string {
  if (values.length === 0) return "";
  if (values.length === 1) return `0,${round(height / 2)}`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const stepX = width / (values.length - 1);
  return values
    .map((v, i) => {
      const x = round(i * stepX);
      // No spread → flat line on the midline; else invert (max at top).
      const y = span === 0 ? height / 2 : height - ((v - min) / span) * height;
      return `${x},${round(y)}`;
    })
    .join(" ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

type FetchState = { sessions: PersistedSession[]; total: number; loading: boolean; error: string | null };

type SessionsResponse = { sessions: PersistedSession[]; total: number };

/**
 * Plain-fetch history list. NO websocket. Re-fetches whenever the filter's
 * query string changes; aborts stale requests. Errors land in `error`.
 * The endpoint returns `{ sessions, total }`; `total` is the full filtered
 * count (not just this page) so callers can paginate.
 */
export function useHistory(filter: HistoryFilter) {
  const qs = historyQueryString(filter);
  const [state, setState] = useState<FetchState>({ sessions: [], total: 0, loading: true, error: null });
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch(`/api/sessions${qs ? `?${qs}` : ""}`, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as SessionsResponse;
      })
      .then(({ sessions, total }) => {
        if (alive) setState({ sessions, total, loading: false, error: null });
      })
      .catch((e) => {
        if (alive && e.name !== "AbortError")
          setState({ sessions: [], total: 0, loading: false, error: String(e?.message ?? e) });
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [qs, nonce]);

  return { ...state, refetch };
}

export type SessionDetail = { session: PersistedSession; events: PersistedEvent[] };

type DetailState = {
  detail: SessionDetail | null;
  samples: SessionSample[];
  loading: boolean;
  error: string | null;
};

/**
 * Fetch one session's registry row + events and its samples. Only fires when
 * `key` is non-null. Plain fetch, no websocket. The samples endpoint returns
 * `200 []` for an unknown key (not 404), which we treat as an empty series.
 */
export function useSessionDetail(key: string | null) {
  const [state, setState] = useState<DetailState>({
    detail: null,
    samples: [],
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (key === null) {
      setState({ detail: null, samples: [], loading: false, error: null });
      return;
    }
    let alive = true;
    const ctrl = new AbortController();
    const enc = encodeURIComponent(key);
    setState({ detail: null, samples: [], loading: true, error: null });
    Promise.all([
      fetch(`/api/sessions/${enc}`, { signal: ctrl.signal }).then(async (r) => {
        if (r.status === 404) throw new Error("session not found");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as SessionDetail;
      }),
      fetch(`/api/sessions/${enc}/samples`, { signal: ctrl.signal }).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as SessionSample[];
      }),
    ])
      .then(([detail, samples]) => {
        if (alive) setState({ detail, samples, loading: false, error: null });
      })
      .catch((e) => {
        if (alive && e.name !== "AbortError")
          setState({ detail: null, samples: [], loading: false, error: String(e?.message ?? e) });
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [key]);

  return state;
}
