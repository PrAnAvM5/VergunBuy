// Third discovery run: BGT walls/fences/canopies and the AHN height rasters (DSM, DTM).
// Saves small JSON summaries and the raw GeoTIFFs to fixtures/probe3 for offline analysis.
import { mkdirSync, writeFileSync } from "node:fs";
const out = "fixtures/probe3";
mkdirSync(out, { recursive: true });
const ORIGIN = { origin: "https://pranavm5.github.io" };
const keepHeaders = (res) =>
  Object.fromEntries(
    [...res.headers].filter(([k]) =>
      /access-control|content-type|content-length|content-crs/i.test(k),
    ),
  );
const saveJson = (n, d) => writeFileSync(`${out}/${n}.json`, JSON.stringify(d, null, 2));

async function getJson(name, url) {
  const res = await fetch(url, { headers: { accept: "application/json", ...ORIGIN } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { nonJson: text.slice(0, 3000) };
  }
  saveJson(name, { url, status: res.status, headers: keepHeaders(res), body });
  console.log(res.status, name);
  return body;
}

const HOMES = {
  verdelingsweg514: [86549.8, 376598.204],
  zonnedauw13: [84909, 383328],
  koppelstraat11: [85747, 375855],
};
const RD = "http://www.opengis.net/def/crs/EPSG/0/28992";
const BGT = "https://api.pdok.nl/kadaster/bgt/ogc/v1";

// 1. Which BGT collections exist (names only).
const cols = await getJson("bgt-collections", `${BGT}/collections?f=json`);
const ids = (cols.collections ?? []).map((c) => c.id);
writeFileSync(`${out}/bgt-collection-ids.txt`, ids.join("\n"));
const wanted = ids.filter((id) => /scheiding|bouwwerk|overkapping|kunstwerk/i.test(id));
console.log("wanted collections:", wanted);

// 2. Items of those collections around each home.
for (const [home, [x, y]] of Object.entries(HOMES)) {
  const bbox = [x - 35, y - 35, x + 35, y + 35].join(",");
  for (const id of wanted) {
    await getJson(
      `bgt-${id}-${home}`,
      `${BGT}/collections/${id}/items?f=json&limit=200&bbox=${bbox}&bbox-crs=${encodeURIComponent(RD)}&crs=${encodeURIComponent(RD)}`,
    );
  }
}

// 3. AHN height rasters from the PDOK WCS.
const WCS = "https://service.pdok.nl/rws/ahn/wcs/v1_0";
const capRes = await fetch(`${WCS}?request=GetCapabilities&service=WCS`, { headers: ORIGIN });
const cap = await capRes.text();
writeFileSync(`${out}/ahn-capabilities.xml`, cap);
const coverages = [...cap.matchAll(/<wcs:CoverageId>([^<]+)<\/wcs:CoverageId>/g)].map((m) => m[1]);
console.log(capRes.status, "AHN coverages:", coverages, keepHeaders(capRes));
const pick = (re) => coverages.find((c) => re.test(c));
const dsm = pick(/dsm.*05|dsm_05m/i) ?? pick(/dsm/i);
const dtm = pick(/dtm.*05|dtm_05m/i) ?? pick(/dtm/i);
const meta = { coverages, dsm, dtm, files: {} };
for (const [home, [x, y]] of Object.entries(HOMES)) {
  for (const cov of [dsm, dtm].filter(Boolean)) {
    const url =
      `${WCS}?service=WCS&version=2.0.1&request=GetCoverage&coverageid=${cov}` +
      `&subset=x(${x - 35},${x + 35})&subset=y(${y - 35},${y + 35})&format=image/tiff`;
    const res = await fetch(url, { headers: ORIGIN });
    const buf = Buffer.from(await res.arrayBuffer());
    const file = `ahn-${cov}-${home}.tif`;
    if (res.ok) writeFileSync(`${out}/${file}`, buf);
    meta.files[file] = { url, status: res.status, bytes: buf.length, headers: keepHeaders(res) };
    console.log(res.status, file, buf.length, JSON.stringify(keepHeaders(res)));
    if (!res.ok) meta.files[file].error = buf.toString("utf8").slice(0, 1500);
  }
}
saveJson("ahn-meta", meta);
