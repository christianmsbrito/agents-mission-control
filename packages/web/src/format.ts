export function fmtUptime(startedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function fmtAgo(ts: number | undefined, now: number): string {
  if (ts === undefined) return "—";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtCost(usd?: number): string {
  if (usd === undefined) return "—";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function fmtTokens(n?: number): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** Compact absolute timestamp, e.g. "Jun 18 15:42". Omits year unless not current. */
export function fmtDate(ts: number, now: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const yearPart = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${yearPart} ${hh}:${mm}`;
}

/** Day bucket label for grouping: "Today" / "Yesterday" / "Mon Jun 18". */
export function dayLabel(ts: number, now: number): string {
  const startOf = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((startOf(now) - startOf(ts)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(ts);
  const W = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const yearPart = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${W[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}${yearPart}`;
}
