/**
 * Probe of the Ruimtelijke Plannen v4 API (old zoning plans) with RP_API_KEY, run in GitHub
 * Actions. Saves the API description and the plan objects at the reference homes under
 * fixtures/rp-probe/ so the adapter can be written against real answers.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BASE = "https://ruimte.omgevingswet.overheid.nl/ruimtelijke-plannen/api/opvragen/v4";
const key = process.env.RP_API_KEY;
if (!key) throw new Error("RP_API_KEY is not set");
const OUT = "fixtures/rp-probe";
mkdirSync(OUT, { recursive: true });

const POINTS: [string, number, number][] = [
  ["verdelingsweg514", 86549.8, 376598.204],
  ["berkenlaan1", 85402, 374971],
  ["zonnedauw13", 84909, 383328],
  ["aalbersestraat1", 81029.282, 381929.681],
  ["markt10a", 81201.381, 379008.519],
  ["bremweg1", 81374, 380528],
];

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "x-api-key": key!,
      accept: "application/hal+json, application/json",
      "content-type": "application/json",
      "content-crs": "epsg:28992",
      "accept-crs": "epsg:28992",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  console.log(`${method} ${path} → ${res.status} (${text.length} bytes)`);
  if (!res.ok) console.log("  ", text.slice(0, 800));
  return { status: res.status, json, text };
}

const save = (name: string, data: unknown) =>
  writeFileSync(`${OUT}/${name}.json.gz`, gzipSync(JSON.stringify(data)));

const RELEVANT = (p: Record<string, unknown>) =>
  p.regelBinding === "burgerbindend" &&
  p.regelStatus === "geldend" &&
  !p.isHistorisch &&
  !["ontwerp", "voorontwerp", "geconsolideerd"].includes(
    String((p.planstatusInfo as { planstatus?: string } | undefined)?.planstatus),
  );

for (const [name, x, y] of POINTS) {
  const geo = { _geo: { contains: { type: "Point", coordinates: [x, y] } } };
  const plans = await call("POST", "/plannen/_zoek?pageSize=100", geo);
  const list =
    (plans.json as { _embedded?: { plannen?: Record<string, unknown>[] } })?._embedded?.plannen ??
    [];
  const out: Record<string, unknown> = { plans: plans.json };
  for (const p of list.filter(RELEVANT)) {
    const id = String(p.id);
    console.log(`  ${name}: ${id} ${String(p.type)} ${String(p.naam)}`);
    const objects = await call("POST", `/plannen/${id}/planobjecten/_zoek?pageSize=100`, geo);
    const articles = await call(
      "POST",
      `/plannen/${id}/artikelen/_zoek?pageSize=100&expand=onderliggendeTeksten`,
      geo,
    );
    out[id] = { objects: objects.json, articles: articles.json ?? articles.text.slice(0, 2000) };
  }
  save(`point2-${name}`, out);
}
