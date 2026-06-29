// Single-machine dev: runs the server AND a local reporter together.
// For multi-machine, run `bun run dev:server` here and `bun run dev:reporter`
// (or the compiled binary) on each host.
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const port = process.env.MC_PORT || "7777";
const token = process.env.MC_TOKEN || "dev-token";

const env = { ...process.env, MC_PORT: port, MC_TOKEN: token };

// --watch hot-reloads both on source changes (no manual restart to pick up edits).
const server = Bun.spawn(["bun", "--watch", join(root, "packages/server/src/index.ts")], {
  env,
  stdio: ["inherit", "inherit", "inherit"],
});

// Reporter reconnects on its own, but give the server a beat to bind.
await Bun.sleep(800);

const reporter = Bun.spawn(["bun", "--watch", join(root, "packages/reporter/src/index.ts")], {
  env: { ...env, MC_SERVER_URL: `ws://localhost:${port}/ws/report` },
  stdio: ["inherit", "inherit", "inherit"],
});

console.log(`[dev] server + local reporter running (hot-reload). open http://localhost:${port}`);
console.log(`[dev] note: web UI changes still need 'bun run build:web'.`);

function shutdown() {
  server.kill();
  reporter.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.race([server.exited, reporter.exited]);
shutdown();
