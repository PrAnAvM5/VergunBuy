// One-off discovery script (runs in GitHub Actions, which can reach PDOK).
// Picks a real Woensdrecht house address, lists the OGC API collections of BAG, BRK and BGT,
// and saves real responses around that address to fixtures/probe/ for adapter development.
import { mkdirSync, writeFileSync } from "node:fs";

const out = "fixtures/probe";
mkdirSync(out, { recursive: true });
const save = (name, data) => writeFileSync(`${out}/${name}.json`, JSON.stringify(data, null, 2));
const RD = "http://www.opengis.net/def/crs/EPSG/0/28992";

async function get(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { nonJson: text.slice(0, 500) };
  }
  return { url, status: res.status, body };
}

const log = [];
async function step(name, url) {
  const r = await get(url);
  log.push({ name, url, status: r.status });
  save(name, r);
  console.log(r.status, name, url);
  return r;
}

// 1. A real house: ordinary number, no letter/addition, with a postcode.
const ls = await step(
  "locatieserver",
  "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=woonplaatsnaam:Hoogerheide&fq=type:adres&rows=50&fl=weergavenaam,postcode,huisnummer,huisletter,huisnummertoevoeging,centroide_rd,adresseerbaarobject_id,nummeraanduiding_id,straatnaam,gemeentenaam",
);
const doc = ls.body.response.docs.find(
  (d) => d.postcode && !d.huisletter && !d.huisnummertoevoeging,
);
const [x, y] = doc.centroide_rd.match(/[-\d.]+/g).map(Number);
const r = 40;
const bbox = [x - r, y - r, x + r, y + r].join(",");
save("chosen", { doc, x, y, bbox });

// 2. Discover collections.
const landings = {
  bag: "https://api.pdok.nl/kadaster/bag/ogc/v2",
  bgt: "https://api.pdok.nl/lv/bgt/ogc/v1",
  brk5: "https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v5",
  brk4: "https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v4",
  brk1: "https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1",
};
const collections = {};
for (const [k, base] of Object.entries(landings)) {
  const c = await step(`collections-${k}`, `${base}/collections?f=json`);
  collections[k] = (c.body.collections ?? []).map((col) => col.id);
}
save("collections-summary", collections);

// 3. Items around the address, in RD New.
const items = (base, coll, limit = 100) =>
  `${base}/collections/${coll}/items?f=json&limit=${limit}&bbox=${bbox}&bbox-crs=${encodeURIComponent(RD)}&crs=${encodeURIComponent(RD)}`;

await step("bag-pand", items(landings.bag, "pand"));
await step("bag-verblijfsobject", items(landings.bag, "verblijfsobject"));
const brkBase = collections.brk5?.length
  ? landings.brk5
  : collections.brk4?.length
    ? landings.brk4
    : landings.brk1;
const brkColl = [
  ...(collections.brk5 ?? []),
  ...(collections.brk4 ?? []),
  ...(collections.brk1 ?? []),
].find((c) => /perceel/i.test(c));
if (brkColl) await step("brk-perceel", items(brkBase, brkColl));
for (const coll of collections.bgt ?? []) {
  if (/wegdeel|waterdeel|terreindeel|pand|overigbouwwerk|scheiding|openbareruimte/i.test(coll)) {
    await step(`bgt-${coll}`, items(landings.bgt, coll));
  }
}
save("log", log);
