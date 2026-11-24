/**
 * Fetches the full text structure (documentstructuur) of the rule documents a renovation type
 * depends on, straight from the DSO (needs DSO_API_KEY), and stores it gzipped under
 * fixtures/dso-docs/. Run by .github/workflows/dso-docs.yml. The stored text is what rule
 * records are verified against; the file name carries the exact version.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BASE =
  "https://service.omgevingswet.overheid.nl/publiek/omgevingsdocumenten/api/presenteren/v8";
const key = process.env.DSO_API_KEY;
if (!key) throw new Error("DSO_API_KEY is not set");

/** [name, path] — in-force documents by work id, drafts by technischId. */
const TARGETS: [string, string][] = JSON.parse(process.env.TARGETS ?? "[]");
const OUT = "fixtures/dso-docs";
mkdirSync(OUT, { recursive: true });

async function get(path: string, query: Record<string, string> = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { "x-api-key": key!, accept: "application/hal+json, application/json" },
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

for (const [name, path] of TARGETS) {
  const { status, text } = await get(path);
  console.log(`${name}: ${path} → ${status}, ${text.length} bytes`);
  if (status !== 200) console.log(text.slice(0, 1500));
  writeFileSync(`${OUT}/${name}.json.gz`, gzipSync(text));
  // A peek at the shape, readable in the log.
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    console.log("  keys:", Object.keys(body).join(", "));
    console.log("  start:", JSON.stringify(body).slice(0, 1200));
  } catch {
    console.log("  not JSON");
  }
}
