// Second discovery run: 3D BAG, BGT trees and driveway crossings, aerial photo service.
import { mkdirSync, writeFileSync } from "node:fs";
const out = "fixtures/probe2";
mkdirSync(out, { recursive: true });
const save = (n, d) => writeFileSync(`${out}/${n}.json`, JSON.stringify(d, null, 2));
const RD = "http://www.opengis.net/def/crs/EPSG/0/28992";
async function get(name, url, init = {}) {
  const res = await fetch(url, {
    headers: { accept: "application/json", origin: "https://pranavm5.github.io" },
    ...init,
  });
  const headers = Object.fromEntries(
    [...res.headers].filter(([k]) => /access-control|content-type|content-crs/i.test(k)),
  );
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { nonJson: text.slice(0, 1500) };
  }
  save(name, { url, status: res.status, headers, body });
  console.log(res.status, name, JSON.stringify(headers));
  return body;
}
// Aalbersestraat 1 Hoogerheide (house pand 0873100000418777) and Bremweg 1 Ossendrecht.
const x = 81029.282,
  y = 381929.681,
  r = 40;
const bbox = [x - r, y - r, x + r, y + r].join(",");
await get(
  "3dbag-pand",
  "https://api.3dbag.nl/collections/pand/items/NL.IMBAG.Pand.0873100000418777",
);
await get(
  "3dbag-bbox",
  `https://api.3dbag.nl/collections/pand/items?bbox=${x - 20},${y - 20},${x + 20},${y + 20}&limit=5`,
);
await get("3dbag-landing", "https://api.3dbag.nl/");
const items = (c) =>
  `https://api.pdok.nl/kadaster/bgt/ogc/v1/collections/${c}/items?f=json&limit=200&bbox=${bbox}&bbox-crs=${encodeURIComponent(RD)}&crs=${encodeURIComponent(RD)}`;
for (const c of [
  "vegetatieobject_punt",
  "vegetatieobject_vlak",
  "weginrichtingselement_lijn",
  "onbegroeidterreindeel",
  "overigbouwwerk",
])
  await get(`bgt-${c}`, items(c));
// Wider search for driveway crossings (inrit) in Hoogerheide centre.
const wide = [x - 300, y - 300, x + 300, y + 300].join(",");
await get(
  "bgt-wegdeel-wide",
  `https://api.pdok.nl/kadaster/bgt/ogc/v1/collections/wegdeel/items?f=json&limit=1000&bbox=${wide}&bbox-crs=${encodeURIComponent(RD)}&crs=${encodeURIComponent(RD)}`,
);
// Aerial photo WMS capabilities (layer names, years).
const caps = await fetch(
  "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0?request=GetCapabilities&service=wms",
);
const capsText = await caps.text();
const layers = [
  ...capsText.matchAll(/<Layer[^>]*>\s*<Name>([^<]+)<\/Name>\s*<Title>([^<]*)<\/Title>/g),
].map((m) => [m[1], m[2]]);
save("luchtfoto-layers", {
  status: caps.status,
  cors: caps.headers.get("access-control-allow-origin"),
  layers,
});
console.log("luchtfoto layers", layers.length);
const img = await fetch(
  `https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0?service=WMS&version=1.3.0&request=GetMap&layers=Actueel_orthoHR&styles=&crs=EPSG:28992&bbox=${bbox}&width=512&height=512&format=image/jpeg`,
  { headers: { origin: "https://pranavm5.github.io" } },
);
save("luchtfoto-getmap", {
  status: img.status,
  type: img.headers.get("content-type"),
  cors: img.headers.get("access-control-allow-origin"),
  bytes: (await img.arrayBuffer()).byteLength,
});
