/**
 * Draws the plot plan as SVG, north up, in real metres (RD New).
 * Every object carries data-sel="<type>:<id>" so a click can open it in the Inspector.
 */
import type { PlotContext } from "@vergunbuy/data";
import { at, type Polygon } from "@vergunbuy/engine";
import { EDGE_TEXT, esc } from "./format.ts";

export interface Layers {
  context: boolean;
  edges: boolean;
}

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

  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#fbfaf7"/>`);

  if (layers.context) {
    for (const p of ctx.nearbyParcels)
      parts.push(`<path d="${path(p.outline)}" fill="none" stroke="#d8d4ca" stroke-width="0.8"/>`);
    for (const a of ctx.publicAreas ?? []) {
      const fill =
        a.kind === "road"
          ? "var(--road)"
          : a.kind === "green"
            ? "var(--green)"
            : a.kind === "water"
              ? "var(--water)"
              : "var(--path)";
      const key = `public:${a.id}`;
      parts.push(
        `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(a.outline)}" fill="${fill}" stroke="#d6d0c2" stroke-width="0.5"/>`,
      );
    }
    for (const b of ctx.neighbours) {
      const key = `neighbour:${b.id}`;
      parts.push(
        `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(b.outline)}" fill="#a8a296" stroke="#857f73" stroke-width="0.6"/>`,
      );
    }
  }

  const plotKey = "plot:main";
  parts.push(
    `<path class="obj${sel(plotKey)}" data-sel="${plotKey}" d="${path(ctx.plot.outline)}" fill="#ffffff" stroke="#1d1f24" stroke-width="1.4"/>`,
  );
  for (const b of ctx.outbuildings) {
    const key = `outbuilding:${b.id}`;
    parts.push(
      `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(b.outline)}" fill="#b9aee8" stroke="#6b5bd2" stroke-width="1"/>`,
    );
  }
  for (const b of ctx.house) {
    const key = `house:${b.id}`;
    parts.push(
      `<path class="obj${sel(key)}" data-sel="${esc(key)}" d="${path(b.outline)}" fill="var(--house)" fill-opacity="0.85" stroke="#4a3db0" stroke-width="1"/>`,
    );
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

  // Scale bar (5 m) and north arrow.
  const bar = 5 * scale;
  parts.push(
    `<g font-family="system-ui" font-size="11" fill="#5a5e66"><line x1="20" y1="${H - 22}" x2="${20 + bar}" y2="${H - 22}" stroke="#5a5e66" stroke-width="2"/><text x="20" y="${H - 30}">5 m</text>` +
      `<path d="M${W - 30},48 L${W - 22},28 L${W - 14},48 L${W - 22},43Z" fill="#5a5e66"/><text x="${W - 26}" y="62">N</text></g>`,
  );
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
  ];
  const edges = Object.values(EDGE_TEXT).map(
    (e) => [e.color, `Edge: ${e.label}`] as [string, string],
  );
  return [...items, ...edges]
    .map(([c, l]) => `<span><i style="background:${c}"></i>${esc(l)}</span>`)
    .join("");
}
