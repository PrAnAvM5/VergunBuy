/**
 * Coverage probe for the plot-edge and object data sources, on the recorded example homes
 * (runs on GitHub Actions: needs PDOK and the AHN storage).
 *
 * Per home:
 *  1. BGT fences/walls (scheiding lijn/vlak) and hedges (vegetatieobject lijn/vlak, plus-type
 *     haag): count, types, and the share of the plot boundary within 1 m of one (all edges and
 *     street-facing edges).
 *  2. Infrared aerial photo (PDOK luchtfotocir WMS): a 0.25 m crop of the plot, saved as PNG,
 *     and the plant index (NDVI) over the laser-scan tree cells, shrub cells and the house roof.
 *  3. AHN point cloud (COPC, AHN6 then AHN5): which tile exists, its point format, and per
 *     laser-scan object class the share of points with several echoes (leaves) vs one (solid).
 *  4. CORS headers for each source as the browser would see them.
 *
 * Output: fixtures/edge-probe/report.json, fixtures/edge-probe/img/*.jpg (infrared crops)
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import jpeg from "jpeg-js";
import { Copc } from "copc";
import { Tracer, contains, type Polygon } from "@vergunbuy/engine";
import { buildPlotContext, findAddress, fixtureFetch } from "@vergunbuy/data";

const OUT = "fixtures/edge-probe";
mkdirSync(`${OUT}/img`, { recursive: true });
const ORIGIN = "https://pranavm5.github.io";
const RD = "http://www.opengis.net/def/crs/EPSG/0/28992";
const BGT = "https://api.pdok.nl/lv/bgt/ogc/v1";
const CIR = "https://service.pdok.nl/hwh/luchtfotocir/wms/v1_0";
const AHN = "https://fsn1.your-objectstorage.com/hwh-ahn";
const LIMIT = Number(process.env.HOMES ?? 60);

type XY = [number, number];
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

async function cors(url: string, init: RequestInit = {}) {
  try {
    const r = await fetch(url, { ...init, headers: { Origin: ORIGIN, ...(init.headers ?? {}) } });
    return {
      status: r.status,
      allowOrigin: r.headers.get("access-control-allow-origin"),
      acceptRanges: r.headers.get("accept-ranges"),
      length: r.headers.get("content-length"),
    };
  } catch (e) {
    return { status: -1, error: String(e) };
  }
}

// ---------- geometry helpers ----------
function segDist(p: XY, a: XY, b: XY) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
  );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function linesOf(geom: { type: string; coordinates: unknown } | null): XY[][] {
  if (!geom) return [];
  const c = geom.coordinates as never;
  switch (geom.type) {
    case "LineString":
      return [c];
    case "MultiLineString":
      return c;
    case "Polygon":
      return (c as XY[][]).slice(0, 1);
    case "MultiPolygon":
      return (c as XY[][][]).map((p) => p[0]!);
    case "Point":
      return [[c, c]];
    default:
      return [];
  }
}
function nearLines(p: XY, lines: XY[][], d: number) {
  for (const l of lines)
    for (let i = 0; i + 1 < l.length; i++) if (segDist(p, l[i]!, l[i + 1]!) <= d) return true;
  return false;
}
/** Points every 0.5 m along the plot boundary, with whether that piece faces public ground. */
function boundarySamples(plot: Polygon, publicAreas: Polygon[]) {
  const out: { p: XY; street: boolean }[] = [];
  for (let i = 0; i < plot.length; i++) {
    const a = plot[i]! as XY;
    const b = plot[(i + 1) % plot.length]! as XY;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / 0.5));
    const nx = -(b[1] - a[1]) / (len || 1);
    const ny = (b[0] - a[0]) / (len || 1);
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const p: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const probe = (s: number): XY => [p[0] + nx * s, p[1] + ny * s];
      const street = publicAreas.some((pa) => contains(pa, probe(1)) || contains(pa, probe(-1)));
      out.push({ p, street });
    }
  }
  return out;
}

// ---------- sources ----------
async function bgt(collection: string, bbox: number[]) {
  const u = new URL(`${BGT}/collections/${collection}/items`);
  u.searchParams.set("f", "json");
  u.searchParams.set("limit", "1000");
  u.searchParams.set("bbox", bbox.map((v) => v.toFixed(2)).join(","));
  u.searchParams.set("bbox-crs", RD);
  u.searchParams.set("crs", RD);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${collection} ${r.status}`);
  const j = (await r.json()) as {
    features: {
      geometry: { type: string; coordinates: unknown } | null;
      properties: Record<string, unknown>;
    }[];
  };
  return j.features.filter((f) => !f.properties.eind_registratie);
}

let cirLayer: string | undefined;
let cirLayers: string[] = [];
async function cirLayerName() {
  if (cirLayer) return cirLayer;
  const xml = await (await fetch(`${CIR}?request=GetCapabilities&service=WMS`)).text();
  cirLayers = [...xml.matchAll(/<Layer[^>]*>\s*<Name>([^<]+)<\/Name>/g)].map((m) => m[1]!);
  cirLayer =
    cirLayers.find((n) => /actueel.*hr/i.test(n)) ??
    cirLayers.find((n) => /actueel/i.test(n)) ??
    cirLayers[cirLayers.length - 1]!;
  return cirLayer;
}

async function cirCrop(bbox: number[], res = 0.25) {
  const layer = await cirLayerName();
  const w = Math.round((bbox[2]! - bbox[0]!) / res);
  const h = Math.round((bbox[3]! - bbox[1]!) / res);
  const u = new URL(CIR);
  for (const [k, v] of Object.entries({
    service: "WMS",
    version: "1.3.0",
    request: "GetMap",
    layers: layer,
    styles: "",
    crs: "EPSG:28992",
    bbox: bbox.join(","),
    width: String(w),
    height: String(h),
    format: "image/jpeg",
  }))
    u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Origin: ORIGIN } });
  const buf = Buffer.from(await r.arrayBuffer());
  const png = jpeg.decode(buf, { useTArray: true });
  // False-colour infrared: red channel = near infrared, green channel = red light.
  const ndviAt = (x: number, y: number) => {
    const i = Math.floor((bbox[3]! - y) / res);
    const j = Math.floor((x - bbox[0]!) / res);
    if (i < 0 || j < 0 || i >= png.height || j >= png.width) return NaN;
    const o = (i * png.width + j) * 4;
    const nir = png.data[o]!;
    const red = png.data[o + 1]!;
    return (nir - red) / (nir + red || 1);
  };
  return { png, buf, ndviAt, allowOrigin: r.headers.get("access-control-allow-origin"), layer };
}

const ahnHead = new Map<string, { url: string; version: string } | null>();
async function ahnTile(x: number, y: number) {
  const cx = Math.floor(x / 1000) * 1000;
  const cy = Math.floor(y / 1000) * 1000;
  const key = `${cx}_${cy}`;
  if (ahnHead.has(key)) return ahnHead.get(key)!;
  const cands: [string, string][] = [
    ...[2025, 2026, 2027].map(
      (yr) => ["AHN6", `${AHN}/AHN6/01_LAZ/AHN6_${yr}_C_${cx}_${cy}.COPC.LAZ`] as [string, string],
    ),
    [
      "AHN5",
      `${AHN}/AHN5_KM/01_LAZ/AHN5_C_${String(cx).padStart(6, "0")}_${String(cy).padStart(6, "0")}.COPC.LAZ`,
    ],
  ];
  for (const [version, url] of cands) {
    const r = await fetch(url, { method: "HEAD" }).catch(() => null);
    if (r?.ok) {
      ahnHead.set(key, { url, version });
      return { url, version };
    }
  }
  ahnHead.set(key, null);
  return null;
}

const copcCache = new Map<string, Awaited<ReturnType<typeof Copc.create>>>();
async function pointsIn(url: string, bbox: number[]) {
  let copc = copcCache.get(url);
  if (!copc) {
    copc = await Copc.create(url);
    copcCache.set(url, copc);
  }
  const { nodes } = await Copc.loadHierarchyPage(url, copc.info.rootHierarchyPage);
  const cube = copc.info.cube;
  const span = cube[3] - cube[0];
  const pts: { x: number; y: number; z: number; ret: number; n: number; cls: number }[] = [];
  let dims: string[] = [];
  for (const [key, node] of Object.entries(nodes)) {
    if (!node || node.pointCount === 0) continue;
    const [d, nx, ny] = key.split("-").map(Number) as [number, number, number];
    const s = span / 2 ** d;
    const x0 = cube[0] + nx * s;
    const y0 = cube[1] + ny * s;
    if (x0 > bbox[2]! || x0 + s < bbox[0]! || y0 > bbox[3]! || y0 + s < bbox[1]!) continue;
    const view = await Copc.loadPointDataView(url, copc, node);
    dims = Object.keys(view.dimensions);
    const gx = view.getter("X");
    const gy = view.getter("Y");
    const gz = view.getter("Z");
    const gr = view.getter("ReturnNumber");
    const gn = view.getter("NumberOfReturns");
    const gc = view.getter("Classification");
    for (let i = 0; i < view.pointCount; i++) {
      const x = gx(i);
      const y = gy(i);
      if (x < bbox[0]! || x > bbox[2]! || y < bbox[1]! || y > bbox[3]!) continue;
      pts.push({ x, y, z: gz(i), ret: gr(i), n: gn(i), cls: gc(i) });
    }
  }
  return { pts, dims, pdrf: copc.header.pointDataRecordFormat };
}

// ---------- main ----------
const dir = "apps/web/public/validation";
const homes: { run: string; file: string }[] = [];
for (const run of readdirSync(dir).filter((d) => !d.endsWith(".json")))
  for (const file of readdirSync(`${dir}/${run}`).filter((x) => x.endsWith(".json.gz.bin")))
    homes.push({ run, file });

const report: Record<string, unknown>[] = [];
const corsSeen: Record<string, unknown> = {};
for (const { run, file } of homes.slice(0, LIMIT)) {
  const rec = JSON.parse(gunzipSync(readFileSync(`${dir}/${run}/${file}`)).toString()) as Record<
    string,
    { links?: unknown[] }
  >;
  for (const b of Object.values(rec)) if (b && typeof b === "object") b.links = [];
  const docs = (rec.locatieserver as unknown as { response: { docs: Record<string, unknown>[] } })
    .response.docs;
  const doc = docs.find((x) => `${slug(String(x.weergavenaam))}.json.gz.bin` === file) ?? docs[0]!;
  const name = String(doc.weergavenaam);
  const addition = `${(doc.huisletter as string) ?? ""}${(doc.huisnummertoevoeging as string) ?? ""}`;
  const row: Record<string, unknown> = { home: name, slug: slug(name) };
  try {
    const t = new Tracer();
    const fetchFn = fixtureFetch(rec as never);
    const a = await t.step("a", "a", (c) =>
      findAddress(
        {
          postcode: String(doc.postcode),
          number: Number(doc.huisnummer),
          ...(addition ? { addition } : {}),
        },
        c,
        fetchFn,
      ),
    );
    const ctx = await buildPlotContext(a, t, fetchFn);
    const plot = ctx.plot.outline;
    const xs = plot.map((p) => p[0]);
    const ys = plot.map((p) => p[1]);
    const bbox = [
      Math.min(...xs) - 3,
      Math.min(...ys) - 3,
      Math.max(...xs) + 3,
      Math.max(...ys) + 3,
    ];
    const pub = (ctx.publicAreas ?? []).map((p) => p.outline);
    const samples = boundarySamples(plot, pub);
    row.boundaryM = samples.length * 0.5;
    row.streetM = samples.filter((s) => s.street).length * 0.5;

    // 1. BGT
    const [sl, sv, vl, vv] = await Promise.all([
      bgt("scheiding_lijn", bbox),
      bgt("scheiding_vlak", bbox),
      bgt("vegetatieobject_lijn", bbox),
      bgt("vegetatieobject_vlak", bbox),
    ]);
    const typeOf = (f: { properties: Record<string, unknown> }) =>
      String(f.properties.plus_type ?? f.properties.type ?? "?");
    const walls = [...sl, ...sv].filter((f) => typeOf(f) !== "niet-bgt" || f.properties.plus_type);
    const hedges = [...vl, ...vv].filter((f) => typeOf(f) === "haag");
    const wallLines = walls.flatMap((f) => linesOf(f.geometry as never));
    const hedgeLines = hedges.flatMap((f) => linesOf(f.geometry as never));
    const cov = (lines: XY[][], street: boolean | null) => {
      const s = samples.filter((x) => street === null || x.street === street);
      return s.length ? s.filter((x) => nearLines(x.p, lines, 1)).length / s.length : null;
    };
    row.bgt = {
      scheiding: walls
        .map(typeOf)
        .reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {}),
      haag: hedges.length,
      wallShareAll: cov(wallLines, null),
      wallShareStreet: cov(wallLines, true),
      hedgeShareAll: cov(hedgeLines, null),
      hedgeShareStreet: cov(hedgeLines, true),
    };

    // 2. Infrared
    const cir = await cirCrop(bbox);
    writeFileSync(`${OUT}/img/${slug(name)}.jpg`, cir.buf);
    corsSeen.cir = cir.allowOrigin;
    const cells = ctx.obstacles?.obstacles ?? [];
    const stat = (vals: number[]) => {
      const v = vals.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
      return v.length
        ? {
            n: v.length,
            median: +v[Math.floor(v.length / 2)]!.toFixed(3),
            plantShare: +(v.filter((x) => x >= 0.2).length / v.length).toFixed(2),
          }
        : null;
    };
    const byKind = (k: string) =>
      cells.filter((g) => g.kind === k).flatMap((g) => g.cells.map((c) => cir.ndviAt(c[0], c[1])));
    const roof: number[] = [];
    for (const h of ctx.house)
      for (
        let x = Math.min(...h.outline.map((p) => p[0]));
        x < Math.max(...h.outline.map((p) => p[0]));
        x += 0.5
      )
        for (
          let y = Math.min(...h.outline.map((p) => p[1]));
          y < Math.max(...h.outline.map((p) => p[1]));
          y += 0.5
        )
          if (contains(h.outline, [x, y])) roof.push(cir.ndviAt(x, y));
    row.cir = {
      layer: cir.layer,
      tall: stat(byKind("tall")),
      medium: stat(byKind("medium")),
      overhang: stat(byKind("overhang")),
      roof: stat(roof),
    };

    // 3. AHN point cloud
    const tile = await ahnTile((bbox[0]! + bbox[2]!) / 2, (bbox[1]! + bbox[3]!) / 2);
    if (tile) {
      if (!corsSeen.ahn)
        corsSeen.ahn = await cors(tile.url, { headers: { Range: "bytes=0-1023" } });
      const { pts, dims, pdrf } = await pointsIn(tile.url, bbox);
      const multi = (sel: typeof pts) =>
        sel.length ? +(sel.filter((p) => p.n > 1).length / sel.length).toFixed(2) : null;
      const nearCells = (k: string) => {
        const cs = cells.filter((g) => g.kind === k).flatMap((g) => g.cells);
        return pts.filter(
          (p) =>
            p.cls !== 2 &&
            cs.some((c) => Math.abs(c[0] - p.x) < 0.25 && Math.abs(c[1] - p.y) < 0.25),
        );
      };
      const roofPts = pts.filter((p) => p.cls === 6);
      row.ahn = {
        version: tile.version,
        pdrf,
        dims,
        points: pts.length,
        classes: pts.reduce<Record<number, number>>(
          (m, p) => ((m[p.cls] = (m[p.cls] ?? 0) + 1), m),
          {},
        ),
        multiEchoTall: multi(nearCells("tall")),
        multiEchoMedium: multi(nearCells("medium")),
        multiEchoRoof: multi(roofPts),
      };
    } else row.ahn = null;
  } catch (e) {
    row.error = String(e).slice(0, 300);
  }
  console.log(JSON.stringify(row));
  report.push(row);
}

corsSeen.bgt = await cors(`${BGT}/collections/scheiding_lijn/items?f=json&limit=1`);
corsSeen.cirCaps = await cors(`${CIR}?request=GetCapabilities&service=WMS`);
writeFileSync(
  `${OUT}/report.json`,
  JSON.stringify({ cors: corsSeen, cirLayers, homes: report }, null, 1),
);
console.log("CORS", JSON.stringify(corsSeen));
console.log("CIR layers", cirLayers.join(", "));
