/** Draws one recorded home's carport analysis as SVG: plot, house, back yard, car reach, options. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  prepare,
  RuleSet,
  options,
  evaluate,
  carAccess,
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
    const opts = options(prep, CARPORT_PRESETS.single);
    const best = opts[0];
    if (process.env.PROBE) {
      const tally: Record<string, number> = {};
      const xs0 = site.plot.map((p) => p[0]);
      const ys0 = site.plot.map((p) => p[1]);
      for (let y = Math.min(...ys0) + 2.5; y < Math.max(...ys0); y += 2)
        for (let x = Math.min(...xs0) + 1.5; x < Math.max(...xs0); x += 2) {
          const v = evaluate(prep, { x, y, rotation: 0, ...CARPORT_PRESETS.single });
          const k =
            v.checks
              .filter((c) => c.group === "feasible" && c.outcome !== "pass")
              .map((c) => `${c.id}:${c.outcome}`)
              .join(",") || "ok";
          tally[k] = (tally[k] ?? 0) + 1;
        }
      console.log(tally);
      const [px, py] = process.env.PROBE.split(",").map(Number);
      if (Number.isFinite(px)) {
        const Lx = prep.vehicle.any!;
        const pl = { x: px!, y: py!, rotation: 0 as const, ...CARPORT_PRESETS.single };
        const acc = carAccess(prep, pl);
        console.log(
          "rect",
          acc.rect,
          "fit",
          acc.fit,
          "via",
          acc.via,
          acc.bays.map((b) => [b.route?.how, b.blocker, b.parked]),
        );
        const s0 = (x: number, y: number, h: number) =>
          ((Math.round(y / 0.5) - Lx.w.j0) * Lx.w.NI + (Math.round(x / 0.5) - Lx.w.i0)) * 8 + h;
        const w = Lx.w;
        let map = "";
        for (let j = w.ny - 1; j >= 0; j -= 2) {
          const y = w.minY + (j + 0.5) * w.cell;
          if (y < py! - 10 || y > py! + 3) continue;
          let row = y.toFixed(1).padStart(6) + " ";
          for (let i = 0; i < w.nx; i += 2) {
            const x = w.minX + (i + 0.5) * w.cell;
            if (x < px! - 8 || x > px! + 8) continue;
            row += w.blocked[j * w.nx + i] ? "#" : ".";
          }
          map += row + "\n";
        }
        console.log(
          map,
          "streetTrees",
          site.streetTrees.filter((t) => Math.abs(t[0] - px!) < 10 && Math.abs(t[1] - py!) < 12),
        );
        for (let y = py! - 12; y <= py!; y += 0.5)
          console.log(
            y.toFixed(1),
            Lx.res.dist[s0(Math.round(px! * 2) / 2, y, 0)],
            Lx.node[s0(Math.round(px! * 2) / 2, y, 0)],
          );
      }
    }
    const L = prep.vehicle.existing ?? prep.vehicle.any;
    console.log(
      "gates",
      L?.w.gates.length,
      "starts",
      L?.starts.size,
      "existing",
      !!prep.vehicle.existing,
      "any",
      !!prep.vehicle.any,
      "entries",
      site.access.entries.map((e) =>
        e.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" → "),
      ),
    );
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
        const e = Math.min(prep.screen.reachExisting.ns[k]!, prep.screen.reachExisting.ew[k]!);
        const an = Math.min(prep.screen.reachAny.ns[k]!, prep.screen.reachAny.ew[k]!);
        const col = Number.isFinite(e)
          ? "#cfe8ff"
          : Number.isFinite(an)
            ? "#ffe9c4"
            : prep.screen.obstacle[k] === 2
              ? "#9c9"
              : "";
        if (!col) continue;
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
    for (const o of opts) {
      parts.push(
        `<path d="${path(o.verdict.outline)}" fill="none" stroke="${o.verdict.colour === "green" ? "#080" : "#c80"}" stroke-width="3"/><text x="${X(o.placement.x)}" y="${Y(o.placement.y)}" font-size="14">${o.n}</text>`,
      );
      const r = o.verdict.access.bays[0]?.route;
      if (r)
        parts.push(
          `<polyline points="${r.poses.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ")}" fill="none" stroke="#06f" stroke-width="1.5"/>`,
        );
    }
    for (const [p, q] of site.access.frontage)
      parts.push(
        `<line x1="${X(p[0])}" y1="${Y(p[1])}" x2="${X(q[0])}" y2="${Y(q[1])}" stroke="#f80" stroke-width="3" stroke-dasharray="4 3"/>`,
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
