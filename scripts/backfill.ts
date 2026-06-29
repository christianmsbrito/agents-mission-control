// Backfill CLI: import historical agent sessions into the persistence store.
//
//   bun run backfill [flags]
//
// Flags:
//   --providers a,b           only these adapter ids (default: all available)
//   --include-hermes-cron     include hermes cron sessions
//   --no-enrich               skip the Haiku enrichment phase (BF10)
//   --enrich-only             skip import; run only the enrichment phase (BF10)
//   --dry-run                 parse + tally, write nothing
//   --batch-size N            enrichment batch size
//
// DB path comes from MC_DB, else ~/.mission-control/mc.db.
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { defaultConfig } from "../packages/server/src/config.ts";
import { Store } from "../packages/server/src/store.ts";
import { runBackfill } from "../packages/server/src/backfill/index.ts";
import type { BackfillOpts, BackfillReport } from "../packages/server/src/backfill/types.ts";

const MAX_PRINTED_REASONS = 5;

/** Pure, hand-rolled flag parser. Unknown flags are ignored. */
export function parseArgs(argv: string[]): BackfillOpts {
  const opts: BackfillOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--providers": {
        const val = argv[++i] ?? "";
        const list = val
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (list.length > 0) opts.providers = list;
        break;
      }
      case "--include-hermes-cron":
        opts.includeHermesCron = true;
        break;
      case "--no-enrich":
        opts.enrich = false;
        break;
      case "--enrich-only":
        opts.enrichOnly = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--batch-size": {
        const n = parseInt(argv[++i] ?? "", 10);
        if (!Number.isNaN(n) && n > 0) opts.batchSize = n;
        break;
      }
      default:
        if (arg.startsWith("--")) {
          console.warn(`[backfill] ignoring unknown flag: ${arg}`);
        }
        break;
    }
  }
  return opts;
}

/** Render the report as a printable string. Pure-ish (no I/O). Caps reasons. */
export function printReport(report: BackfillReport): string {
  const lines: string[] = [];
  const ids = Object.keys(report.providers);
  if (ids.length === 0) {
    lines.push("(no available providers)");
  }
  for (const id of ids) {
    const pr = report.providers[id];
    if (pr.failed) {
      const reason = pr.reasons[0] ?? "unknown error";
      lines.push(`${id}: FAILED: ${reason}`);
      continue;
    }
    const status = pr.reasons.length === 0 ? ", ok" : ", done with skips";
    let line = `${id}: ${pr.imported} imported, ${pr.skipped} skipped${status}`;
    if (pr.reasons.length > 0) {
      const shown = pr.reasons.slice(0, MAX_PRINTED_REASONS);
      const more = pr.reasons.length - shown.length;
      const suffix = more > 0 ? ` (+${more} more)` : "";
      line += `\n  reasons: ${shown.join("; ")}${suffix}`;
    }
    lines.push(line);
  }
  if (report.enrich) {
    const e = report.enrich;
    if (e.skippedPhase) {
      lines.push("enrich: skipped");
    } else {
      lines.push(`enrich: ${e.enriched} enriched, ${e.degraded} degraded`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const config = defaultConfig(process.env);
  const dbPath = process.env.MC_DB || join(homedir(), ".mission-control", "mc.db");

  if (dbPath !== ":memory:") {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch {
      /* best-effort: Store() will surface a real open error below */
    }
  }

  const store = new Store(dbPath, { retention: config.retention });
  try {
    const report = await runBackfill(store, opts);
    console.log(printReport(report));
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[backfill] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
