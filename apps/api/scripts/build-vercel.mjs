/* global console, URL */
/**
 * Builds the API for Vercel as one bundled file using the Build Output API v3, so what runs on
 * Vercel is exactly the code tested here (no per-file TypeScript compilation on their side).
 * Output: <repo root>/.vercel/output/{config.json, static/, functions/api.func/}
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Vercel looks for .vercel/output at the root of the repository (the project root).
const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = `${root}.vercel/output`;
rmSync(out, { recursive: true, force: true });
const fn = `${out}/functions/api.func`;
mkdirSync(fn, { recursive: true });
mkdirSync(`${out}/static`, { recursive: true });

await build({
  entryPoints: [fileURLToPath(new URL("../src/vercel-entry.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: `${fn}/index.mjs`,
  // Some dependencies use require(); give the ESM bundle a require function.
  banner: {
    // ... and __dirname / __filename (the LAZ decoder looks for its .wasm next to itself).
    js: [
      "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      "import { fileURLToPath as __vbPath } from 'url'; import { dirname as __vbDir } from 'path';",
      "const __filename = __vbPath(import.meta.url); const __dirname = __vbDir(__filename);",
    ].join("\n"),
  },
  logLevel: "info",
});
// The LAZ decoder (laser point clouds) is WebAssembly: ship its .wasm next to the bundle.
const lazPerfDir = dirname(createRequire(import.meta.url).resolve("laz-perf"));
copyFileSync(`${lazPerfDir}/laz-perf.wasm`, `${fn}/laz-perf.wasm`);
writeFileSync(
  `${fn}/.vc-config.json`,
  JSON.stringify(
    // Zoning searches read many pages; allow up to 60 s (the Hobby plan maximum).
    { runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", maxDuration: 60 },
    null,
    2,
  ),
);
writeFileSync(`${fn}/package.json`, JSON.stringify({ type: "module" }));
writeFileSync(
  `${out}/config.json`,
  JSON.stringify({ version: 3, routes: [{ src: "/api/(.*)", dest: "/api" }] }, null, 2),
);
writeFileSync(
  `${out}/static/index.html`,
  "<!doctype html><title>VergunBuy API</title><p>VergunBuy API. Try <a href='/api/health'>/api/health</a>.</p>",
);
console.log("Vercel build output written to", out);
