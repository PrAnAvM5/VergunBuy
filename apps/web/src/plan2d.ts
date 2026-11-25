/**
 * Workspace 2D plan: only the plot and what stands on it, in the plot's own frame
 * (street at the bottom), with architectural dimension lines drawn outside the shapes.
 */
import type { PlotContext } from "@vergunbuy/data";
import { boundaryRuns, polyToLocal, toLocal, type Point, type Polygon } from "@vergunbuy/engine";
import { bandOf, esc, isOtherHomeOnParcel, OVERHANG_COLOR } from "./format.ts";

const W = 820;
const H = 620;

/** Colours of the street-side plot line by what stands on it. */
export const LINE_COLORS = {
  exit: "#f2b134",
  open: "#1f6fd1",
  hedge: "#2f7d32",
  barrier: "#3a3a3a",
  unknown: "#9a6fd0",
} as const;
export const LINE_TEXT = {
  exit: "Plot line: registered driveway crossing",
  open: "Plot line on the street side: open (nothing 0.6 m or higher)",
  hedge: "Plot line on the street side: hedge",
  barrier: "Plot line on the street side: fence or wall",
  unknown: "Plot line on the street side: something, make-up unknown",
} as const;
/** Laser-scan cells of something solid (not a plant): a wall, a car, a shed not registered. */
export const SOLID_COLOR = "#6d6a65";

export interface PlanScene {
  /** SVG content (no <svg> wrapper). */
  body: string;
  W: number;
  H: number;
  /** Plot-frame metres to SVG units, and back. */
  tx: (x: number) => number;
  ty: (y: number) => number;
  fromSvg: (px: number, py: number) => [number, number];
  scale: number;
}

export function drawWorkspacePlan(ctx: PlotContext, selected?: string, showDims = true): string {
  const s = planScene(ctx, { selected, showDims });
  return `<svg viewBox="0 0 ${s.W} ${s.H}" role="img" aria-label="Plot plan with the street at the bottom and main dimensions">${s.body}</svg>`;
}

/**
 * The 2D plan as a reusable scene, so the carport planner draws on exactly the same plan.
 * `padBottom`: room below the plot for the street (the carport planner needs more, for the car).
 */
export function planScene(
  ctx: PlotContext,
  opts: {
    selected?: string | undefined;
    showDims?: boolean;
    padBottom?: number;
  } = {},
): PlanScene {
  const selected = opts.selected;
  const showDims = opts.showDims ?? true;
  const f = ctx.frame;
  const L = ctx.layout;
  const plot = polyToLocal(f, ctx.plot.outline);
  // Room around the plot for the street strip and the dimension lines.
  const pad = { left: 9, right: 9, top: 7, bottom: opts.padBottom ?? 10 };
  const minX = L.plot.minX - pad.left;
  const maxX = L.plot.maxX + pad.right;
  const minY = L.plot.minY - pad.bottom;
  const maxY = L.plot.maxY + pad.top;
  const scale = Math.min(W / (maxX - minX), H / (maxY - minY));
  const ox = (W - (maxX - minX) * scale) / 2;
  const oy = (H - (maxY - minY) * scale) / 2;
  const tx = (x: number) => ox + (x - minX) * scale;
  const ty = (y: number) => H - (oy + (y - minY) * scale);
  const path = (poly: Polygon) =>
    `M${poly.map((p) => `${tx(p[0]).toFixed(1)},${ty(p[1]).toFixed(1)}`).join("L")}Z`;
  const sel = (key: string) => (key === selected ? " selected" : "");
  const near = (poly: Polygon) =>
    poly.some((p) => p[0] > minX && p[0] < maxX && p[1] > minY && p[1] < maxY);

  const parts: string[] = [`<rect width="${W}" height="${H}" fill="#fbfaf7"/>`];

  // Street side: public areas touching the front, drawn as a band with the street name.
  for (const a of ctx.publicAreas ?? []) {
    const poly = polyToLocal(f, a.outline);
    if (!near(poly)) continue;
    const isExit = ctx.exits.some((e) => e.id === a.id);
    const fill = isExit
      ? "#f2b134"
      : a.kind === "road"
        ? "#e4dfd3"
        : a.kind === "green"
          ? "#cfe5bf"
          : a.kind === "water"
            ? "#cde3f3"
            : "#efebe2";
    parts.push(
      `<path class="obj${sel(`${isExit ? "exit" : "public"}:${a.id}`)}" data-sel="${esc(`${isExit ? "exit" : "public"}:${a.id}`)}" d="${path(poly)}" fill="${fill}" stroke="none"/>`,
    );
  }
  // Neighbouring buildings near the plot, faint.
  for (const b of ctx.neighbours) {
    const poly = polyToLocal(f, b.outline);
    if (!near(poly)) continue;
    parts.push(
      `<path class="obj${sel(`neighbour:${b.id}`)}" data-sel="${esc(`neighbour:${b.id}`)}" d="${path(poly)}" fill="#d9d5cc" stroke="#bdb7ab" stroke-width="0.6"/>`,
    );
  }
  // Clip everything outside the drawing area cleanly.
  parts.push(
    `<path class="obj${sel("plot:main")}" data-sel="plot:main" d="${path(plot)}" fill="#ffffff" stroke="#1d1f24" stroke-width="2"/>`,
  );
  // Other homes on the same parcel stand on "this plot" too, so draw them above the plot fill.
  const otherHomes = ctx.neighbours.filter(isOtherHomeOnParcel);
  for (const b of otherHomes) {
    const key = `neighbour:${b.id}`;
    parts.push(
      `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(polyToLocal(f, b.outline))}" fill="#2a9d8f" fill-opacity="0.35" stroke="#1f7a6f" stroke-width="1.4" stroke-dasharray="6 4"/>`,
    );
  }
  for (const b of ctx.outbuildings) {
    const key = `outbuilding:${b.id}`;
    parts.push(
      `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(polyToLocal(f, b.outline))}" fill="#b9aee8" stroke="#6b5bd2" stroke-width="1.2"/>`,
    );
  }
  for (const b of ctx.house) {
    const key = `house:${b.id}`;
    parts.push(
      `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(polyToLocal(f, b.outline))}" fill="#6b5bd2" fill-opacity="0.85" stroke="#4a3db0" stroke-width="1.4"/>`,
    );
  }
  // Obstacles from the height scan: cells drawn in the plot frame.
  const half = (ctx.obstacles?.res ?? 0.5) / 2;
  for (const o of ctx.obstacles?.obstacles ?? []) {
    const key = `obstacle:${o.id}`;
    // One path per colour: each cell coloured by its own height.
    const byColor = new Map<string, string[]>();
    o.cells.forEach(([x, y], i) => {
      const color =
        o.kind === "overhang"
          ? OVERHANG_COLOR
          : o.kind === "medium" && o.cellMaterials?.[i] === "solid"
            ? SOLID_COLOR
            : bandOf(o.cellHeights[i] ?? 1).color;
      const d = path(
        polyToLocal(f, [
          [x - half, y - half],
          [x + half, y - half],
          [x + half, y + half],
          [x - half, y + half],
        ]),
      );
      byColor.set(color, [...(byColor.get(color) ?? []), d]);
    });
    for (const [color, ds] of byColor)
      parts.push(
        `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${ds.join("")}" fill="${color}" fill-opacity="0.6" stroke="none"/>`,
      );
  }
  for (const s of ctx.structures) {
    const key = `structure:${s.id}`;
    parts.push(
      `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(polyToLocal(f, s.outline))}" fill="#00b8d9" fill-opacity="0.15" stroke="#00b8d9" stroke-width="1.4"/>`,
    );
  }
  for (const t of ctx.trees ?? []) {
    const p = toLocal(f, t.at);
    if (p[0] < minX || p[0] > maxX || p[1] < minY || p[1] > maxY) continue;
    const key = `tree:${t.id}`;
    parts.push(
      `<circle class="obj${sel(key)}" data-sel="${esc(key)}" cx="${tx(p[0]).toFixed(1)}" cy="${ty(p[1]).toFixed(1)}" r="${((t.crownM / 2) * scale).toFixed(1)}" fill="#3f8f3a" fill-opacity="0.4" stroke="#1f5e1c" stroke-dasharray="3 2"/>`,
    );
  }

  // What stands on the plot line, on the street side.
  for (const r of boundaryRuns(ctx.boundary?.pieces ?? [])) {
    if (r.side !== "street") continue;
    const a = toLocal(f, r.a);
    const b = toLocal(f, r.b);
    parts.push(
      `<line x1="${tx(a[0]).toFixed(1)}" y1="${ty(a[1]).toFixed(1)}" x2="${tx(b[0]).toFixed(1)}" y2="${ty(b[1]).toFixed(1)}" stroke="${LINE_COLORS[r.state]}" stroke-width="${r.state === "open" ? 3 : 6}" stroke-linecap="butt" ${r.state === "open" || r.state === "unknown" ? 'stroke-dasharray="7 5"' : ""}><title>${esc(`${LINE_TEXT[r.state]}, ${r.lengthM} m${r.heightM !== null && r.state !== "exit" ? `, up to ${r.heightM} m high` : ""}`)}</title></line>`,
    );
  }

  // Labels inside the shapes: just names, no numbers.
  const text = (x: number, y: number, s: string, size = 13, color = "#1d1f24", weight = 600) =>
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="system-ui" font-size="${size}" font-weight="${weight}" text-anchor="middle" dominant-baseline="central" fill="${color}" pointer-events="none">${esc(s)}</text>`;
  if (L.house)
    parts.push(
      text(
        tx((L.house.minX + L.house.maxX) / 2),
        ty((L.house.minY + L.house.maxY) / 2),
        ctx.unitsInHouse > 1 ? `Building with ${ctx.unitsInHouse} units` : "House",
        13,
        "#ffffff",
      ),
    );
  for (const b of otherHomes) {
    const box = polyToLocal(f, b.outline);
    const cx = box.reduce((s, p) => s + p[0], 0) / box.length;
    const cy = box.reduce((s, p) => s + p[1], 0) / box.length;
    parts.push(
      text(
        tx(cx),
        ty(cy),
        `Other home${b.addressLabels?.length ? ` (${b.addressLabels.join(", ")})` : ""}`,
        12,
        "#11473f",
      ),
    );
  }
  const streetY = L.plot.minY - 3;
  if (f.method !== "none")
    parts.push(
      text(
        tx((L.plot.minX + L.plot.maxX) / 2),
        ty(streetY - 3.2),
        f.streetName ? f.streetName : "Street side (estimated)",
        13,
        "#5a5e66",
        500,
      ),
    );

  if (showDims) {
    const C = "#2f3540";
    // A dimension line between two points with end ticks and a centred label.
    const dim = (a: Point, b: Point, label: string, side: "below" | "left" | "right" | "above") => {
      const [x1, y1, x2, y2] = [tx(a[0]), ty(a[1]), tx(b[0]), ty(b[1])];
      const vertical = Math.abs(x1 - x2) < 1;
      const tick = (x: number, y: number) =>
        vertical ? `M${x - 5},${y}L${x + 5},${y}` : `M${x},${y - 5}L${x},${y + 5}`;
      const lx = (x1 + x2) / 2 + (side === "left" ? -6 : side === "right" ? 6 : 0);
      const ly = (y1 + y2) / 2 + (side === "below" ? 12 : side === "above" ? -12 : 0);
      const anchor = side === "left" ? "end" : side === "right" ? "start" : "middle";
      return (
        `<path d="M${x1.toFixed(1)},${y1.toFixed(1)}L${x2.toFixed(1)},${y2.toFixed(1)}${tick(x1, y1)}${tick(x2, y2)}" stroke="${C}" stroke-width="1" fill="none"/>` +
        `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-family="system-ui" font-size="12" text-anchor="${anchor}" dominant-baseline="central" fill="${C}" stroke="#fbfaf7" stroke-width="3" paint-order="stroke">${esc(label)}</text>`
      );
    };
    const p = L.plot;
    // Plot width (along the street), below the street band.
    parts.push(
      dim([p.minX, p.minY - 7], [p.maxX, p.minY - 7], `Plot width ${L.plotWidthM} m`, "below"),
    );
    // Plot depth, left.
    parts.push(dim([p.minX - 5, p.minY], [p.minX - 5, p.maxY], `${L.plotDepthM} m deep`, "left"));
    if (L.house && L.setbacks) {
      const h = L.house;
      const s = L.setbacks;
      // Chain on the right: front gap | house depth | rear gap.
      const xr = p.maxX + 3;
      if (s.frontM > 0.3)
        parts.push(dim([xr, p.minY], [xr, h.minY], `front ${s.frontM} m`, "right"));
      parts.push(dim([xr, h.minY], [xr, h.maxY], `house ${L.houseDepthM} m`, "right"));
      if (s.rearM > 0.3)
        parts.push(dim([xr, h.maxY], [xr, p.maxY], `garden ${s.rearM} m`, "right"));
      // Chain on top: left gap | house width | right gap.
      const yt = p.maxY + 3;
      if (s.leftM > 0.3) parts.push(dim([p.minX, yt], [h.minX, yt], `${s.leftM} m`, "above"));
      parts.push(dim([h.minX, yt], [h.maxX, yt], `house ${L.houseWidthM} m`, "above"));
      if (s.rightM > 0.3) parts.push(dim([h.maxX, yt], [p.maxX, yt], `${s.rightM} m`, "above"));
    }
  }

  // Scale bar.
  const bar = 5 * scale;
  parts.push(
    `<g font-family="system-ui" font-size="11" fill="#5a5e66"><line x1="16" y1="${H - 16}" x2="${16 + bar}" y2="${H - 16}" stroke="#5a5e66" stroke-width="2"/><text x="16" y="${H - 24}">5 m</text></g>`,
  );
  return {
    body: parts.join(""),
    W,
    H,
    tx,
    ty,
    fromSvg: (px, py) => [(px - ox) / scale + minX, (H - py - oy) / scale + minY],
    scale,
  };
}
