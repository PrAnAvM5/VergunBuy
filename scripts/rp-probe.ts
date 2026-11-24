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

// 1. The API description: paths and the search body schemas.
for (const p of ["/openapi.json", "/api-docs", "/"]) {
  const r = await call("GET", p);
  if (r.status === 200 && r.json) {
    save("spec", r.json);
    const paths = Object.keys((r.json as { paths?: object }).paths ?? {});
    console.log("paths:", paths.join("\n  "));
    break;
  }
}

// 2. Plans at each point, then every object type inside the main plans at that point.
const OBJECTS = [
  "bestemmingsvlakken",
  "bouwvlakken",
  "functieaanduidingen",
  "bouwaanduidingen",
  "gebiedsaanduidingen",
  "lettertekenaanduidingen",
  "maatvoeringen",
  "figuren",
];
for (const [name, x, y] of POINTS) {
  const geo = { _geo: { contains: { type: "Point", coordinates: [x, y] } } };
  const plans = await call("POST", "/plannen/_zoek?pageSize=100", geo);
  const out: Record<string, unknown> = { plans: plans.json };
  const list =
    (
      plans.json as {
        _embedded?: {
          plannen?: { id: string; naam?: string; planType?: string; planStatusInfo?: unknown }[];
        };
      }
    )?._embedded?.plannen ?? [];
  for (const p of list) console.log(`  ${name}: ${p.id} ${p.planType} ${p.naam}`);
  for (const p of list.filter((p) =>
    /bestemmingsplan|beheersverordening|inpassingsplan|omgevingsvergunning|paraplu/i.test(
      String(p.planType),
    ),
  )) {
    const objs: Record<string, unknown> = {};
    for (const o of OBJECTS) {
      const r = await call(
        "POST",
        `/plannen/${encodeURIComponent(p.id)}/${o}/_zoek?pageSize=100`,
        geo,
      );
      objs[o] = r.json ?? { status: r.status, text: r.text.slice(0, 500) };
    }
    out[p.id] = objs;
  }
  save(`point-${name}`, out);
}
