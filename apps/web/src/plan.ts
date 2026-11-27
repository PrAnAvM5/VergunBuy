/**
 * Map view: the plot in its neighbourhood, north up, in real metres (RD New).
 * Every object carries data-sel="<type>:<id>" so a click can open it in the Inspector.
 * Underlay: the national aerial photo (PDOK, CC BY 4.0) for the chosen year. With the photo on,
 * overlays are drawn as thin outlines so they never wash out the photo.
 */
import { smoothedPieces } from "./plotLine.ts";
import type { PlotContext } from "@vergunbuy/data";
import { at, boundaryRuns, type Polygon } from "@vergunbuy/engine";
import { EDGE_TEXT, esc } from "./format.ts";
import {
  KERB_COLORS,
  LAMP_COLOR,
  LINE_COLORS,
  POLE_COLOR,
  SOLID_COLOR,
  streetObjectSvg,
} from "./plan2d.ts";

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

/** Native resolution of the open aerial photo (metres per pixel). */
const PHOTO_M_PER_PX = 0.08;
const W = 820;
const H = 600;

export function drawPlan(ctx: PlotContext, layers: Layers, selected?: string): string {
  const xs = ctx.plot.outline.map((p) => p[0]);
  const ys = ctx.plot.outline.map((p) => p[1]);
  // At least ~60 m tall: the photo is 8 cm per pixel, so a tighter view only stretches it.
  const margin = 14;
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const halfH = Math.max(
    (Math.max(...ys) - Math.min(...ys)) / 2 + margin,
    ((Math.max(...xs) - Math.min(...xs)) / 2 + margin) * (H / W),
    30,
  );
  const halfW = halfH * (W / H);
  const minX = cx - halfW;
  const minY = cy - halfH;
  const scale = W / (2 * halfW);
  const tx = (x: number) => (x - minX) * scale;
  const ty = (y: number) => H - (y - minY) * scale;
  const path = (poly: Polygon) =>
    `M${poly.map((p) => `${tx(p[0]).toFixed(1)},${ty(p[1]).toFixed(1)}`).join("L")}Z`;
  const sel = (key: string) => (key === selected ? " selected" : "");
  const photo = layers.aerial !== "";

  const parts: string[] = [`<rect width="${W}" height="${H}" fill="#fbfaf7"/>`];

  if (photo) {
    const ex = [minX, minY, minX + 2 * halfW, minY + 2 * halfH];
    // Ask for the photo at its native resolution: no server-side stretching.
    const pw = Math.min(4000, Math.round((2 * halfW) / PHOTO_M_PER_PX));
    const ph = Math.min(4000, Math.round((2 * halfH) / PHOTO_M_PER_PX));
    const url =
      `https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0?service=WMS&version=1.3.0&request=GetMap` +
      `&layers=${encodeURIComponent(layers.aerial)}&styles=&crs=EPSG:28992&bbox=${ex.map((n) => n.toFixed(2)).join(",")}` +
      `&width=${pw}&height=${ph}&format=image/jpeg`;
    parts.push(
      `<image href="${esc(url)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>`,
    );
  }

  if (layers.context) {
    for (const p of ctx.nearbyParcels)
      parts.push(
        `<path d="${path(p.outline)}" fill="none" stroke="${photo ? "#ffffff" : "#d8d4ca"}" stroke-opacity="${photo ? 0.35 : 1}" stroke-width="0.8"/>`,
      );
    for (const a of ctx.publicAreas ?? []) {
      const isExit = ctx.exits.some((e) => e.id === a.id);
      const key = isExit ? `exit:${a.id}` : `public:${a.id}`;
      if (photo) {
        parts.push(
          `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(a.outline)}" fill="#ffffff" fill-opacity="0.001" stroke="${isExit ? "#f2b134" : "#ffffff"}" stroke-opacity="${isExit ? 1 : 0.3}" stroke-width="${isExit ? 2.2 : 0.6}"/>`,
        );
      } else {
        const fill = isExit
          ? "#f2b134"
          : a.kind === "road"
            ? "var(--road)"
            : a.kind === "green"
              ? "var(--green)"
              : a.kind === "water"
                ? "var(--water)"
                : "var(--path)";
        parts.push(
          `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(a.outline)}" fill="${fill}" fill-opacity="${isExit ? 0.85 : 1}" stroke="${isExit ? "#b07a1a" : "#d6d0c2"}" stroke-width="${isExit ? 1.2 : 0.5}"/>`,
        );
      }
    }
    for (const h of ctx.hedges)
      parts.push(
        `<path class="obj" data-sel="hedge:${esc(h.id)}" d="${path(h.outline)}" fill="#2f7d32" fill-opacity="${photo ? 0.001 : 0.7}" stroke="${photo ? "#9be07f" : "#2f5d22"}" stroke-width="${photo ? 1.2 : 0.6}"/>`,
      );
    for (const b of ctx.neighbours) {
      const key = `neighbour:${b.id}`;
      parts.push(
        `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(b.outline)}" fill="#a8a296" fill-opacity="${photo ? 0.001 : 1}" stroke="${photo ? "#ffffff" : "#857f73"}" stroke-opacity="${photo ? 0.6 : 1}" stroke-width="${photo ? 1 : 0.8}"/>`,
      );
    }
  }

  const plotKey = "plot:main";
  parts.push(
    `<path class="obj${sel(plotKey)}" data-sel="${plotKey}" d="${path(ctx.plot.outline)}" fill="#ffffff" fill-opacity="${photo ? 0.001 : 1}" stroke="${photo ? "#ffffff" : "#1d1f24"}" stroke-width="${photo ? 2.2 : 1.4}"/>`,
  );
  for (const b of ctx.outbuildings) {
    const key = `outbuilding:${b.id}`;
    parts.push(
      `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(b.outline)}" fill="#b9aee8" fill-opacity="${photo ? 0.15 : 1}" stroke="${photo ? "#d6ccff" : "#6b5bd2"}" stroke-width="1.6"/>`,
    );
  }
  for (const b of ctx.house) {
    const key = `house:${b.id}`;
    parts.push(
      `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(b.outline)}" fill="var(--house)" fill-opacity="${photo ? 0.15 : 0.85}" stroke="${photo ? "#c9c0ff" : "#4a3db0"}" stroke-width="${photo ? 2 : 1.4}"/>`,
    );
  }

  if (layers.context && ctx.trees) {
    for (const t of ctx.trees) {
      const key = `tree:${t.id}`;
      parts.push(
        `<circle class="obj${sel(key)}" data-sel="${esc(key)}" cx="${tx(t.at[0]).toFixed(1)}" cy="${ty(t.at[1]).toFixed(1)}" r="${((t.crownM / 2) * scale).toFixed(1)}" fill="#3f8f3a" fill-opacity="${photo ? 0.001 : 0.45}" stroke="${photo ? "#9be07f" : "#1f5e1c"}" stroke-width="1.2" stroke-dasharray="3 2"/>` +
          `<circle cx="${tx(t.at[0]).toFixed(1)}" cy="${ty(t.at[1]).toFixed(1)}" r="2.5" fill="${photo ? "#9be07f" : "#1f5e1c"}" pointer-events="none"/>`,
      );
    }
  }

  if (layers.context)
    for (const o of ctx.streetObjects ?? [])
      parts.push(streetObjectSvg(tx(o.at[0]), ty(o.at[1]), o.kind));

  if (layers.edges) {
    ctx.edges.forEach((run, i) => {
      const a = at(ctx.plot.outline, run.edge);
      const b = at(ctx.plot.outline, run.edge + 1);
      const p = (t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as const;
      const [x1, y1] = p(run.from);
      const [x2, y2] = p(run.to);
      const style = EDGE_TEXT[run.kind] ?? { color: "#000" };
      const key = `edge:${i}`;
      // The street side is drawn by what stands on it (below), when that is known.
      const color = run.kind === "public" && ctx.boundary ? "#bfc3ca" : style.color;
      parts.push(
        `<line class="edge${sel(key)}" data-sel="${key}" x1="${tx(x1).toFixed(1)}" y1="${ty(y1).toFixed(1)}" x2="${tx(x2).toFixed(1)}" y2="${ty(y2).toFixed(1)}" stroke="${color}" stroke-width="5" stroke-linecap="butt"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""}/>`,
      );
    });
    for (const r of boundaryRuns(smoothedPieces(ctx.boundary?.pieces ?? []))) {
      if (r.side !== "street" || r.state === "exit") continue;
      parts.push(
        `<polyline points="${r.points.map((q) => `${tx(q[0]).toFixed(1)},${ty(q[1]).toFixed(1)}`).join(" ")}" fill="none" stroke="${LINE_COLORS[r.state]}" stroke-width="${r.state === "open" ? 3 : 6}" stroke-linejoin="round" pointer-events="none"${r.state === "open" || r.state === "unknown" ? ' stroke-dasharray="7 5"' : ""}/>`,
      );
    }
  }

  // Stretches of boundary where a car can reach the plot.
  // Same marking for stretches where the road lies just beyond a pavement or verge.
  for (const e of [...ctx.carReachableEdges, ...(ctx.pavementRuns ?? [])]) {
    const a = at(ctx.plot.outline, e.edge);
    const b = at(ctx.plot.outline, e.edge + 1);
    const p = (t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as const;
    const [x1, y1] = p(e.from);
    const [x2, y2] = p(e.to);
    parts.push(
      `<line x1="${tx(x1).toFixed(1)}" y1="${ty(y1).toFixed(1)}" x2="${tx(x2).toFixed(1)}" y2="${ty(y2).toFixed(1)}" stroke="#f2b134" stroke-width="10" stroke-opacity="0.6" stroke-dasharray="8 5" pointer-events="none"/>`,
    );
  }

  // Street names from the map register.
  if (layers.context)
    for (const l of ctx.streetNames)
      parts.push(
        `<text x="${tx(l.at[0]).toFixed(1)}" y="${ty(l.at[1]).toFixed(1)}" font-family="system-ui" font-size="12" font-weight="600" text-anchor="middle" fill="${photo ? "#ffffff" : "#5a5e66"}" stroke="${photo ? "#000000" : "#fbfaf7"}" stroke-opacity="${photo ? 0.55 : 1}" stroke-width="3" paint-order="stroke" pointer-events="none">${esc(l.name)}</text>`,
      );

  // Scale bar (10 m) and north arrow.
  const bar = 10 * scale;
  const ink = photo ? "#ffffff" : "#5a5e66";
  parts.push(
    `<g font-family="system-ui" font-size="11" fill="${ink}"><line x1="20" y1="${H - 22}" x2="${20 + bar}" y2="${H - 22}" stroke="${ink}" stroke-width="2"/><text x="20" y="${H - 30}">10 m</text>` +
      `<path d="M${W - 30},48 L${W - 22},28 L${W - 14},48 L${W - 22},43Z" fill="${ink}"/><text x="${W - 26}" y="62">N</text></g>`,
  );
  if (photo) {
    const year = AERIAL_YEARS.find(([k]) => k === layers.aerial)?.[1] ?? "";
    parts.push(
      `<text x="${W - 12}" y="${H - 12}" text-anchor="end" font-family="system-ui" font-size="10" fill="#ffffff" stroke="#000" stroke-opacity="0.4" stroke-width="2" paint-order="stroke">Aerial photo ${esc(year)} (8 cm per pixel): Beeldmateriaal Nederland via PDOK (CC BY 4.0)</text>`,
    );
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of the plot with house, neighbours and public areas">${parts.join("")}</svg>`;
}

/**
 * The legend for one view. The aerial map shows edge types and where a car could reach the plot
 * (map register); the 2D plan shows what stands on the street side of the plot line (laser scan)
 * and the objects in the street.
 */
export function legend(view: "map" | "plan" = "plan"): string {
  const sw = (c: string, l: string, kind: "box" | "line" | "dash" | "dot" = "box") =>
    `<span><i class="${kind === "line" || kind === "dash" ? `ln${kind === "dash" ? " dash" : ""}` : kind === "dot" ? "dot" : ""}" style="${kind === "line" || kind === "dash" ? `border-color:${c}` : `background:${c}`}"></i>${esc(l)}</span>`;
  const group = (title: string, items: string[]) =>
    `<div class="lg-group"><b>${esc(title)}</b>${items.join("")}</div>`;
  const buildings = group("Buildings", [
    sw("var(--house)", "House"),
    sw("#b9aee8", "Other building on the plot"),
    sw("#2a9d8f", "Other home, same parcel"),
    sw("#a8a296", "Neighbours"),
    sw("#00b8d9", "Canopy, pool (registered)"),
  ]);
  const garden = group("Garden (laser scan)", [
    sw("#d63c3c", "Tree, 2.5 m+"),
    sw("#e8961e", "1.5–2.5 m"),
    sw("#f0d04a", "1–1.5 m"),
    sw(SOLID_COLOR, "Solid, not a plant"),
    sw("#8a7fd6", "Neighbour's tree overhanging"),
    sw("#2f7d32", "Hedge (registered)"),
  ]);
  if (view === "map")
    return [
      buildings,
      group("Street", [
        sw("var(--road)", "Road"),
        sw("var(--path)", "Footpath"),
        sw("var(--green)", "Public green"),
        sw("#3f8f3a", "Street tree", "dot"),
        sw("#f2b134", "Registered driveway crossing"),
        sw("#f2b134", "Car could reach here (no exit registered)", "dash"),
      ]),
      garden,
      group("Plot edges (what lies beyond)", [
        ...["public", "neighbour", "shared-wall", "rear-path", "water"].map((k) =>
          sw(
            EDGE_TEXT[k]!.color,
            k === "public" ? "Street, path or green" : EDGE_TEXT[k]!.label,
            "line",
          ),
        ),
      ]),
    ].join("");
  return [
    buildings,
    group("Street", [
      sw("var(--road)", "Road"),
      sw("var(--path)", "Footpath"),
      sw("var(--green)", "Public green"),
      sw("#3f8f3a", "Street tree", "dot"),
      sw(LAMP_COLOR, "Lamp post", "dot"),
      sw(POLE_COLOR, "Pole, bollard, cabinet"),
      sw("#f2b134", "Driveway crossing"),
    ]),
    garden,
    group("Street side of the plot line (laser scan)", [
      sw(LINE_COLORS.open, "Open (under 0.6 m)", "dash"),
      sw(LINE_COLORS.hedge, "Hedge", "line"),
      sw(LINE_COLORS.barrier, "Fence or wall", "line"),
      sw(LINE_COLORS.unknown, "Unclear", "dash"),
      sw(LINE_COLORS.exit, "Registered exit", "line"),
    ]),
    group("Kerb along the road (laser scan)", [
      sw(KERB_COLORS.raised, "Raised kerb", "line"),
      sw(KERB_COLORS.lowered, "Lowered kerb (driveway)", "line"),
      sw(KERB_COLORS.unclear, "Unclear", "dash"),
    ]),
  ].join("");
}
