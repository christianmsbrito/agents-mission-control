import { rm } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
const outdir = join(root, "dist");
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(root, "src", "index.html")],
  outdir,
  minify: true,
  naming: "[name].[ext]",
  define: { "process.env.NODE_ENV": '"production"' },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`[web] built ${result.outputs.length} files -> ${outdir}`);
