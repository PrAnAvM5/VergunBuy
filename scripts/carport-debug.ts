/** Draws one recorded home's carport analysis as SVG: plot, house, back yard, routes, best spot. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  prepare,
  RuleSet,
  suggest,
  CARPORT_PRESETS,
  Tracer,
  type Polygon,
} from "@vergunbuy/engine";
import { buildPlotContext, carportSite, findAddress, fixtureFetch } from "@vergunbuy/data";

const want = process.argv[2]!;
const rules = RuleSet.parse(
  JSON.parse(readFileSync("rulesets/woensdrecht/carport/2026-11-24.json", "utf8")),
);
const dir = "apps/web/public/validation";
for (const run of readdirSync(dir).filter((d) => !d.endsWith(".json")))
  for (const f of readdirSync(`${dir}/${run}`).filter(
    (x) => x.startsWith(want) && x.endsWith(".bin"),
  )) {
    const rec = JSON.parse(gunzipSync(readFileSync(`${dir}/${run}/${f}`)).toString());
    for (const b of Object.values(rec) as { links?: unknown[] }[])
      if (b && typeof b === "object") b.links = [];
    const docs = rec.locatieserver.response.docs as Record<string, unknown>[];
    const doc =
      docs.find((d) =>
        String(d.weergavenaam)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .startsWith(want),
      ) ?? docs[0]!;
    const addition = `${(doc.huisletter as string) ?? ""}${(doc.huisnummertoevoeging as string) ?? ""}`;
    const fetchFn = fixtureFetch(rec);
    const t = new Tracer();
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
    const { site } = carportSite(ctx, rules, { current: null, checkedAt: null, source: "none" });
    if (!site) continue;
    const prep = prepare(site);
    const { best, green } = suggest(prep, CARPORT_PRESETS.single);
    const xs = site.plot.map((p) => p[0]);
    const ys = site.plot.map((p) => p[1]);
    const pad = 6;
    const [x0, x1, y0, y1] = [
      Math.min(...xs) - pad,
      Math.max(...xs) + pad,
      Math.min(...ys) - pad,
      Math.max(...ys) + pad,
    ];
    const S = 700 / Math.max(x1 - x0, y1 - y0);
    const X = (x: number) => (x - x0) * S;
    const Y = (y: number) => (y1 - y) * S;
    const path = (p: Polygon) =>
      `M${p.map((q) => `${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join("L")}Z`;
    const parts: string[] = [`<rect width="100%" height="100%" fill="white"/>`];
    const g = prep.grid;
    for (let j = 0; j < g.ny; j++)
      for (let i = 0; i < g.nx; i++) {
        const k = j * g.nx + i;
        if (!g.passable[k]) continue;
        const col = Number.isFinite(g.dist[k]) ? "#cfe8ff" : "#ffe0e0";
        parts.push(
          `<rect x="${X(g.minX + i * g.cell).toFixed(1)}" y="${Y(g.minY + (j + 1) * g.cell).toFixed(1)}" width="${(g.cell * S).toFixed(1)}" height="${(g.cell * S).toFixed(1)}" fill="${col}"/>`,
        );
      }
    for (const pa of site.publicAreas ?? [])
      parts.push(`<path d="${path(pa)}" fill="#ddd" fill-opacity="0.6" stroke="#999"/>`);
    for (const part of prep.yard.region)
      parts.push(
        `<path d="${path(part.outer)}" fill="#7c7" fill-opacity="0.25" stroke="#3a3" stroke-dasharray="4 3"/>`,
      );
    parts.push(`<path d="${path(site.plot)}" fill="none" stroke="black" stroke-width="2"/>`);
    for (const h of site.house)
      parts.push(`<path d="${path(h.outline)}" fill="#c96" stroke="#743"/>`);
    for (const b of site.buildings)
      parts.push(`<path d="${path(b.outline)}" fill="#bbb" stroke="#666"/>`);
    for (const s of site.structures)
      parts.push(`<path d="${path(s.outline)}" fill="none" stroke="#a0a" stroke-dasharray="3 2"/>`);
    for (const [p, q] of site.access.entries)
      parts.push(
        `<line x1="${X(p[0])}" y1="${Y(p[1])}" x2="${X(q[0])}" y2="${Y(q[1])}" stroke="#06f" stroke-width="5"/>`,
      );
    for (const c of green)
      parts.push(`<circle cx="${X(c.x)}" cy="${Y(c.y)}" r="1.5" fill="#080"/>`);
    if (best)
      parts.push(
        `<path d="${path(best.verdict.outline)}" fill="none" stroke="${best.verdict.colour === "green" ? "#080" : best.verdict.colour === "amber" ? "#c80" : "#c00"}" stroke-width="3"/>`,
      );
    writeFileSync(
      `/tmp/${want}.svg`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${(x1 - x0) * S}" height="${(y1 - y0) * S}">${parts.join("")}</svg>`,
    );
    console.log(
      a.label,
      ctx.frame.method,
      site.front,
      site.publicSides,
      site.access.level,
      site.access.entries.length,
      "entries; yard line",
      prep.yard.frontLineY?.toFixed(1),
      best?.verdict.headline,
    );
    console.log(
      best?.verdict.checks
        .filter((c) => c.outcome !== "pass")
        .map((c) => `${c.id}: ${c.detail}`)
        .join("\n"),
    );
  }
