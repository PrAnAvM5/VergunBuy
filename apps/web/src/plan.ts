/**
 * Draws the plot plan as SVG, north up, in real metres (RD New).
 * Every object carries data-sel="<type>:<id>" so a click can open it in the Inspector.
 * Optional underlay: the national aerial photo (PDOK, CC BY 4.0) for the chosen year.
 */
import type { PlotContext } from "@vergunbuy/data";
import { at, type Polygon } from "@vergunbuy/engine";
import { EDGE_TEXT, esc } from "./format.ts";

export interface Layers {
  context: boolean;
  edges: boolean;
  dimensions: boolean;
  /** Aerial photo layer name, or "" for none. */
  aerial: string;
}

export const AERIAL_YEARS: [string, string][] = [
  ["", "No photo"],
  ["Actueel_orthoHR", "Latest photo"],
  ["2025_orthoHR", "2025"],
  ["2024_orthoHR", "2024"],
  ["2023_orthoHR", "2023"],
  ["2022_orthoHR", "2022"],
  ["2021_orthoHR", "2021"],
  ["2020_ortho25", "2020"],
  ["2018_ortho25", "2018"],
  ["2016_ortho25", "2016"],
];

const W = 820;
const H = 600;

export function drawPlan(ctx: PlotContext, layers: Layers, selected?: string): string {
  const xs = ctx.plot.outline.map((p) => p[0]);
  const ys = ctx.plot.outline.map((p) => p[1]);
  const margin = 14;
  const minX = Math.min(...xs) - margin;
  const maxX = Math.max(...xs) + margin;
  const minY = Math.min(...ys) - margin;
  const maxY = Math.max(...ys) + margin;
  const scale = Math.min(W / (maxX - minX), H / (maxY - minY));
  const ox = (W - (maxX - minX) * scale) / 2;
  const oy = (H - (maxY - minY) * scale) / 2;
  const tx = (x: number) => ox + (x - minX) * scale;
  const ty = (y: number) => H - (oy + (y - minY) * scale);
  const path = (poly: Polygon) =>
    `M${poly.map((p) => `${tx(p[0]).toFixed(1)},${ty(p[1]).toFixed(1)}`).join("L")}Z`;
  const sel = (key: string) => (key === selected ? " selected" : "");
  const photo = layers.aerial !== "";
  const fillOp = photo ? 0.35 : 1;

  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#fbfaf7"/>`);

  if (photo) {
    // Exact RD extent of the drawing, so the photo lines up with the plan.
    const ex = [
      minX - ox / scale,
      minY - oy / scale,
      minX + (W - ox) / scale,
      minY + (H - oy) / scale,
    ];
    const url =
      `https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0?service=WMS&version=1.3.0&request=GetMap` +
      `&layers=${encodeURIComponent(layers.aerial)}&styles=&crs=EPSG:28992&bbox=${ex.map((n) => n.toFixed(2)).join(",")}` +
      `&width=${W * 2}&height=${H * 2}&format=image/jpeg`;
    parts.push(
      `<image href="${esc(url)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>`,
    );
  }

  if (layers.context) {
    for (const p of ctx.nearbyParcels)
      parts.push(
        `<path d="${path(p.outline)}" fill="none" stroke="${photo ? "#ffffff" : "#d8d4ca"}" stroke-opacity="${photo ? 0.5 : 1}" stroke-width="0.8"/>`,
      );
    for (const a of ctx.publicAreas ?? []) {
      const isExit = ctx.exits.some((e) => e.id === a.id);
      const fill = isExit
        ? "#f2b134"
        : a.kind === "road"
          ? "var(--road)"
          : a.kind === "green"
            ? "var(--green)"
            : a.kind === "water"
              ? "var(--water)"
              : "var(--path)";
      const key = isExit ? `exit:${a.id}` : `public:${a.id}`;
      parts.push(
        `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(a.outline)}" fill="${fill}" fill-opacity="${isExit ? 0.85 : fillOp}" stroke="${isExit ? "#b07a1a" : "#d6d0c2"}" stroke-width="${isExit ? 1.2 : 0.5}"/>`,
      );
    }
    for (const h of ctx.hedges)
      parts.push(
        `<path class="obj" data-sel="hedge:${esc(h.id)}" d="${path(h.outline)}" fill="#4f8a3c" fill-opacity="0.7" stroke="#2f5d22" stroke-width="0.6"/>`,
      );
    for (const b of ctx.neighbours) {
      const key = `neighbour:${b.id}`;
      parts.push(
        `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(b.outline)}" fill="#a8a296" fill-opacity="${fillOp}" stroke="${photo ? "#ffffff" : "#857f73"}" stroke-width="0.8"/>`,
      );
    }
  }

  const plotKey = "plot:main";
  parts.push(
    `<path class="obj${sel(plotKey)}" data-sel="${plotKey}" d="${path(ctx.plot.outline)}" fill="#ffffff" fill-opacity="${photo ? 0 : 1}" stroke="${photo ? "#ffffff" : "#1d1f24"}" stroke-width="${photo ? 2 : 1.4}"/>`,
  );
  for (const b of ctx.outbuildings) {
    const key = `outbuilding:${b.id}`;
    parts.push(
      `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(b.outline)}" fill="#b9aee8" fill-opacity="${photo ? 0.5 : 1}" stroke="#6b5bd2" stroke-width="1.2"/>`,
    );
  }
  for (const b of ctx.house) {
    const key = `house:${b.id}`;
    parts.push(
      `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(b.outline)}" fill="var(--house)" fill-opacity="${photo ? 0.45 : 0.85}" stroke="#4a3db0" stroke-width="1.4"/>`,
    );
  }

  if (layers.context && ctx.trees) {
    for (const t of ctx.trees) {
      const key = `tree:${t.id}`;
      parts.push(
        `<circle class="obj${sel(key)}" data-sel="${esc(key)}" cx="${tx(t.at[0]).toFixed(1)}" cy="${ty(t.at[1]).toFixed(1)}" r="${((t.crownM / 2) * scale).toFixed(1)}" fill="#3f8f3a" fill-opacity="0.45" stroke="#1f5e1c" stroke-width="1" stroke-dasharray="3 2"/>` +
          `<circle cx="${tx(t.at[0]).toFixed(1)}" cy="${ty(t.at[1]).toFixed(1)}" r="2.5" fill="#1f5e1c" pointer-events="none"/>`,
      );
    }
  }

  if (layers.edges) {
    ctx.edges.forEach((run, i) => {
      const a = at(ctx.plot.outline, run.edge);
      const b = at(ctx.plot.outline, run.edge + 1);
      const p = (t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as const;
      const [x1, y1] = p(run.from);
      const [x2, y2] = p(run.to);
      const style = EDGE_TEXT[run.kind] ?? { color: "#000" };
      const key = `edge:${i}`;
      parts.push(
        `<line class="edge${sel(key)}" data-sel="${key}" x1="${tx(x1).toFixed(1)}" y1="${ty(y1).toFixed(1)}" x2="${tx(x2).toFixed(1)}" y2="${ty(y2).toFixed(1)}" stroke="${style.color}" stroke-width="6" stroke-linecap="butt"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""}/>`,
      );
    });
  }

  if (layers.dimensions) {
    const label = (x: number, y: number, text: string, size = 12) =>
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="system-ui" font-size="${size}" font-weight="600" text-anchor="middle" dominant-baseline="central" fill="#1d1f24" stroke="#ffffff" stroke-width="3.5" paint-order="stroke" pointer-events="none">${esc(text)}</text>`;
    const ring = ctx.plot.outline;
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    ring.forEach((a, i) => {
      const b = at(ring, i + 1);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 2.5) return;
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      // Push the label outward, away from the plot centre.
      const dx = mx - cx;
      const dy = my - cy;
      const d = Math.hypot(dx, dy) || 1;
      parts.push(
        label(tx(mx + (dx / d) * 1.6), ty(my + (dy / d) * 1.6), `${len.toFixed(1)} m`, 11),
      );
    });
    for (const b of [...ctx.house, ...ctx.outbuildings]) {
      if (!b.lengthM || !b.widthM) continue;
      const bx = b.outline.reduce((s, p) => s + p[0], 0) / b.outline.length;
      const by = b.outline.reduce((s, p) => s + p[1], 0) / b.outline.length;
      const h = b.heights?.heightM;
      parts.push(
        label(
          tx(bx),
          ty(by),
          `${b.lengthM} × ${b.widthM} m${h ? ` · ${h} m` : ""}`,
          ctx.house.includes(b) ? 12 : 10,
        ),
      );
    }
  }

  // Scale bar (5 m) and north arrow.
  const bar = 5 * scale;
  const ink = photo ? "#ffffff" : "#5a5e66";
  parts.push(
    `<g font-family="system-ui" font-size="11" fill="${ink}"><line x1="20" y1="${H - 22}" x2="${20 + bar}" y2="${H - 22}" stroke="${ink}" stroke-width="2"/><text x="20" y="${H - 30}">5 m</text>` +
      `<path d="M${W - 30},48 L${W - 22},28 L${W - 14},48 L${W - 22},43Z" fill="${ink}"/><text x="${W - 26}" y="62">N</text></g>`,
  );
  if (photo) {
    const year = AERIAL_YEARS.find(([k]) => k === layers.aerial)?.[1] ?? "";
    parts.push(
      `<text x="${W - 12}" y="${H - 12}" text-anchor="end" font-family="system-ui" font-size="10" fill="#ffffff" stroke="#000" stroke-opacity="0.4" stroke-width="2" paint-order="stroke">Aerial photo ${esc(year)}: Beeldmateriaal Nederland via PDOK (CC BY 4.0)</text>`,
    );
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Plan of the plot with house, neighbours and public areas">${parts.join("")}</svg>`;
}

export function legend(): string {
  const items: [string, string][] = [
    ["var(--house)", "House"],
    ["#b9aee8", "Other building on plot"],
    ["#a8a296", "Neighbouring buildings"],
    ["var(--road)", "Road"],
    ["var(--path)", "Footpath"],
    ["var(--green)", "Public green"],
    ["#f2b134", "Driveway crossing (exit)"],
    ["#3f8f3a", "Registered tree"],
    ["#4f8a3c", "Hedge"],
  ];
  const edges = Object.values(EDGE_TEXT).map(
    (e) => [e.color, `Edge: ${e.label}`] as [string, string],
  );
  return [...items, ...edges]
    .map(([c, l]) => `<span><i style="background:${c}"></i>${esc(l)}</span>`)
    .join("");
}
