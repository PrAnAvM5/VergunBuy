/**
 * Probe: national monuments (rijksmonumenten) and protected town/village views in Woensdrecht,
 * from the RCE data on PDOK. Saves the raw answers under fixtures/rp-probe/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BASE = "https://api.pdok.nl/rce/beschermde-gebieden-cultuurhistorie/ogc/v1";
const CRS = "http://www.opengis.net/def/crs/EPSG/0/28992";
const BBOX = [74000, 370000, 90000, 388000]; // all of Woensdrecht with margin
mkdirSync("fixtures/rp-probe", { recursive: true });

const meta = await fetch(`${BASE}/collections?f=json`).then((r) => r.json());
console.log(JSON.stringify(meta).slice(0, 3000));
for (const c of ["rce_inspire_polygons", "rce_inspire_points"]) {
  const all: unknown[] = [];
  let url: string | undefined =
    `${BASE}/collections/${c}/items?f=json&limit=1000&bbox=${BBOX.join(",")}&bbox-crs=${encodeURIComponent(CRS)}&crs=${encodeURIComponent(CRS)}`;
  while (url) {
    const res = await fetch(url);
    const j = (await res.json()) as {
      features?: unknown[];
      links?: { rel: string; href: string }[];
    };
    console.log(c, res.status, j.features?.length);
    all.push(...(j.features ?? []));
    url = j.links?.find((l) => l.rel === "next")?.href;
  }
  console.log(c, "total", all.length, JSON.stringify(all[0]).slice(0, 1500));
  writeFileSync(`fixtures/rp-probe/heritage-${c}.json.gz`, gzipSync(JSON.stringify(all)));
}
