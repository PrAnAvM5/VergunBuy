/**
 * Probe: where can a home's permit history come from?
 *  1. Officiële bekendmakingen (Gemeenteblad) via the public SRU search of repository.overheid.nl.
 *  2. The DSO's omgevingsvergunningen endpoint (Presenteren v8).
 * Saves raw answers under fixtures/permit-probe/.
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "fixtures/permit-probe";
mkdirSync(OUT, { recursive: true });
const HOMES: [string, string, number, number][] = [
  ["aalbersestraat1", "Aalbersestraat 1", 81029.282, 381929.681],
  ["zonnedauw13", "Zonnedauw 13", 84909, 383328],
  ["verdelingsweg514", "Verdelingsweg 514", 86549.8, 376598.204],
  ["markt10a", "Markt 10", 81201.381, 379008.519],
];

// 1. SRU search of official publications.
for (const [name, street] of HOMES) {
  const q = `c.product-area==officielepublicaties AND dt.creator=="Woensdrecht" AND cql.textAndIndexes="${street}"`;
  const url = `https://repository.overheid.nl/sru?query=${encodeURIComponent(q)}&maximumRecords=50&httpAccept=application/xml`;
  const res = await fetch(url).catch((e) => ({ status: String(e), text: async () => "" }) as const);
  const text = await res.text();
  console.log(`SRU ${name}: ${res.status} ${text.length} bytes`);
  console.log(
    (
      text.match(
        /<dcterms:title>[^<]*<\/dcterms:title>|<dcterms:modified>[^<]*|<dcterms:identifier>[^<]*/g,
      ) ?? []
    )
      .slice(0, 30)
      .join("\n"),
  );
  writeFileSync(`${OUT}/sru-${name}.xml`, text);
}

// 2. DSO omgevingsvergunningen: the API description and a search at each home.
const BASE =
  "https://service.omgevingswet.overheid.nl/publiek/omgevingsdocumenten/api/presenteren/v8";
const key = process.env.DSO_API_KEY!;
const spec = (await fetch(`${BASE}/openapi.json`, { headers: { "x-api-key": key } }).then((r) =>
  r.json(),
)) as {
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown> };
};
const part = Object.fromEntries(
  Object.entries(spec.paths).filter(([p]) => p.includes("omgevingsvergunning")),
);
const schemas = Object.fromEntries(
  Object.entries(spec.components.schemas).filter(([n]) => /vergunning/i.test(n)),
);
writeFileSync(`${OUT}/dso-spec-vergunningen.json`, JSON.stringify({ part, schemas }, null, 1));
console.log(JSON.stringify(part).slice(0, 3000));
console.log(Object.keys(schemas).join(", "));
for (const [name, , x, y] of HOMES) {
  const res = await fetch(`${BASE}/omgevingsvergunningen/_zoek?size=100`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "content-type": "application/json",
      accept: "application/hal+json",
      "content-crs": "http://www.opengis.net/def/crs/EPSG/0/28992",
    },
    body: JSON.stringify({ geometrie: { type: "Point", coordinates: [x, y] } }),
  });
  const text = await res.text();
  console.log(`DSO vergunningen ${name}: ${res.status} ${text.slice(0, 1500)}`);
  writeFileSync(`${OUT}/dso-${name}.json`, text);
}
