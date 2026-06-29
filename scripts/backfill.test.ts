import { expect, test } from "bun:test";
import { parseArgs, printReport } from "./backfill.ts";
import type { BackfillReport, ProviderReport } from "../packages/server/src/backfill/types.ts";

function pr(over: Partial<ProviderReport> = {}): ProviderReport {
  return { imported: 0, skipped: 0, failed: false, reasons: [], ...over };
}

test("parses providers list", () => {
  expect(parseArgs(["--providers", "claude,codex"]).providers).toEqual(["claude", "codex"]);
});

test("include-hermes-cron flag", () => {
  expect(parseArgs(["--include-hermes-cron"]).includeHermesCron).toBe(true);
});

test("no-enrich sets enrich false", () => {
  expect(parseArgs(["--no-enrich"]).enrich).toBe(false);
});

test("enrich-only flag", () => {
  expect(parseArgs(["--enrich-only"]).enrichOnly).toBe(true);
});

test("batch-size parses int", () => {
  expect(parseArgs(["--batch-size", "20"]).batchSize).toBe(20);
});

test("dry-run flag", () => {
  expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
});

test("defaults are sane", () => {
  const o = parseArgs([]);
  expect(o.dryRun ?? false).toBe(false);
  expect(o.providers).toBeUndefined();
});

test("ignores a NaN batch-size", () => {
  expect(parseArgs(["--batch-size", "abc"]).batchSize).toBeUndefined();
});

test("providers trims and drops empties", () => {
  expect(parseArgs(["--providers", " claude , , codex "]).providers).toEqual(["claude", "codex"]);
});

test("batch-size rejects zero", () => {
  expect(parseArgs(["--batch-size", "0"]).batchSize).toBeUndefined();
});

test("batch-size rejects negative", () => {
  expect(parseArgs(["--batch-size", "-5"]).batchSize).toBeUndefined();
});

test("printReport: counts + reasons capped at 5 with (+N more)", () => {
  const reasons = Array.from({ length: 8 }, (_, i) => `r${i + 1}`);
  const report: BackfillReport = {
    providers: { claude: pr({ imported: 10, skipped: 8, reasons }) },
  };
  const out = printReport(report);
  expect(out).toContain("claude: 10 imported, 8 skipped");
  expect(out).not.toContain(", ok"); // has reasons -> not "ok"
  expect(out).toContain("done with skips");
  expect(out).toContain("r1; r2; r3; r4; r5 (+3 more)");
  expect(out).not.toContain("r6");
});

test("printReport: clean provider shows ok with no reasons", () => {
  const report: BackfillReport = {
    providers: { codex: pr({ imported: 3, skipped: 0 }) },
  };
  const out = printReport(report);
  expect(out).toBe("codex: 3 imported, 0 skipped, ok");
});

test("printReport: failed provider shows FAILED line", () => {
  const report: BackfillReport = {
    providers: { hermes: pr({ failed: true, reasons: ["file is not a database"] }) },
  };
  expect(printReport(report)).toBe("hermes: FAILED: file is not a database");
});

test("printReport: empty providers", () => {
  expect(printReport({ providers: {} })).toBe("(no available providers)");
});

test("printReport: enrich summary renders", () => {
  const report: BackfillReport = {
    providers: { claude: pr({ imported: 1 }) },
    enrich: { enriched: 4, degraded: 1, skippedPhase: false },
  };
  expect(printReport(report)).toContain("enrich: 4 enriched, 1 degraded");
});

test("printReport: enrich skippedPhase renders", () => {
  const report: BackfillReport = {
    providers: { claude: pr({ imported: 1 }) },
    enrich: { enriched: 0, degraded: 0, skippedPhase: true },
  };
  expect(printReport(report)).toContain("enrich: skipped");
});
