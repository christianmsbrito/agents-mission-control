import { test, expect } from "bun:test";
import { LEXICONS } from "./lexicon.ts";
import { SKINS } from "./prefs.ts";

// Deep set of leaf key-paths, so a new theme can't ship with a partial lexicon.
function keyPaths(o: any, prefix = ""): string[] {
  if (o && typeof o === "object" && !Array.isArray(o)) {
    return Object.keys(o).flatMap((k) => keyPaths(o[k], prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}

test("every registered skin has a lexicon", () => {
  for (const { id } of SKINS) expect(LEXICONS[id]).toBeDefined();
});

test("all lexicons share the same shape (no missing terms)", () => {
  const ref = keyPaths(LEXICONS.ff).sort();
  for (const { id } of SKINS) {
    // jobs is an open map (provider->name), compare structure minus its leaves
    const paths = keyPaths(LEXICONS[id]).filter((p) => !p.startsWith("jobs.")).sort();
    const refTrim = ref.filter((p) => !p.startsWith("jobs.")).sort();
    expect(paths).toEqual(refTrim);
  }
});
