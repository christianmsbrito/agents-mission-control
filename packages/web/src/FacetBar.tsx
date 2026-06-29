import type { FacetBucket } from "./useQuery.ts";
import { useLex } from "./lexicon.ts";

export type FacetSel = { provider?: string; category?: string; host?: string; state?: string };

function Group({ label, dim, buckets, sel, onToggle }: {
  label: string;
  dim: keyof FacetSel;
  buckets: FacetBucket[];
  sel: FacetSel;
  onToggle: (dim: keyof FacetSel, v: string) => void;
}) {
  if (buckets.length === 0) return null;
  return (
    <div className="facetgroup">
      <span className="lbl">{label}</span>
      {buckets.slice(0, 12).map((b) => (
        <button
          key={b.value}
          className="chip"
          aria-pressed={sel[dim] === b.value}
          onClick={() => onToggle(dim, b.value)}
          title={b.label ?? b.value}
        >
          {b.label ?? b.value}<span className="n">{b.count}</span>
        </button>
      ))}
    </div>
  );
}

export function FacetBar({ facets, sel, onToggle, showState }: {
  facets: { providers: FacetBucket[]; categories: FacetBucket[]; hosts: FacetBucket[]; states?: FacetBucket[] };
  sel: FacetSel;
  onToggle: (dim: keyof FacetSel, v: string) => void;
  showState?: boolean;
}) {
  const lex = useLex();
  return (
    <div className="facets">
      {showState && facets.states && <Group label={lex.facet.fate} dim="state" buckets={facets.states} sel={sel} onToggle={onToggle} />}
      <Group label={lex.facet.klass} dim="provider" buckets={facets.providers} sel={sel} onToggle={onToggle} />
      <Group label={lex.facet.role} dim="category" buckets={facets.categories} sel={sel} onToggle={onToggle} />
      <Group label={lex.facet.realm} dim="host" buckets={facets.hosts} sel={sel} onToggle={onToggle} />
    </div>
  );
}
