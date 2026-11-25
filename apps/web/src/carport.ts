/**
 * Carport workspace: place, drag, resize and rotate a carport on the real plot, with every rule
 * checked live and the best spot suggested. Drawn in the plot's own frame (street at the bottom).
 */
import type { PlotContext } from "@vergunbuy/data";
import { carportSite } from "@vergunbuy/data";
import {
  CARPORT_HEIGHT_M,
  CARPORT_LIMITS,
  CARPORT_PRESETS,
  evaluate,
  prepare,
  rectangle,
  RuleSet,
  suggest,
  type CarportCheck,
  type CarportVerdict,
  type CurrentVersion,
  type Placement,
  type Polygon,
  type Prepared,
} from "@vergunbuy/engine";
import rulesJson from "../../../rulesets/woensdrecht/carport/2026-11-24.json";
import { esc } from "./format.ts";

const RULES = RuleSet.parse(rulesJson);
const W = 820;
const H = 620;

interface Snapshot {
  takenAt: string;
  points: { documents: CurrentVersion[]; drafts: CurrentVersion[] }[];
}
let snapshot: Promise<Snapshot | null> | undefined;
function loadSnapshot(): Promise<Snapshot | null> {
  snapshot ??= fetch(`${import.meta.env.BASE_URL}rules/dso-snapshot.json`)
    .then((r) => (r.ok ? (r.json() as Promise<Snapshot>) : null))
    .catch(() => null);
  return snapshot;
}

const GROUPS: [CarportCheck["group"], string][] = [
  ["feasible", "Can it stand here?"],
  ["permit-free", "Permit-free (omgevingsplan art. 22.27)"],
  ["allowed-by-law", "Allowed regardless of the old zoning plan (art. 22.36)"],
  ["exclusion", "Exceptions (art. 22.28, 22.38, 22.39)"],
  ["technical", "Technical building rules (Bbl 2.25)"],
  ["freshness", "Rules up to date"],
];
const ICON = { pass: "✓", fail: "✕", unknown: "?" } as const;
const COLOUR = { green: "#2f7d32", amber: "#b26a00", red: "#b3261e" } as const;

export interface CarportView {
  dispose(): void;
}

export async function mountCarport(el: HTMLElement, ctx: PlotContext): Promise<CarportView> {
  const dsoSnap = await loadSnapshot();
  const { site, gate } = carportSite(ctx, RULES, {
    current: dsoSnap
      ? {
          inForce: dsoSnap.points.flatMap((p) => p.documents),
          drafts: dsoSnap.points.flatMap((p) => p.drafts),
        }
      : null,
    checkedAt: dsoSnap?.takenAt ?? null,
    source: dsoSnap ? "snapshot" : "none",
  });
  if (!site) {
    el.innerHTML = `<div class="carport-msg"><h3>No carport check for this home</h3><p>${esc(gate ?? "")}</p></div>`;
    return { dispose: () => (el.innerHTML = "") };
  }
  const prep: Prepared = prepare(site);

  let size: { widthM: number; lengthM: number } = { ...CARPORT_PRESETS.single };
  let heat: { x: number; y: number; rotation: 0 | 90 }[] = [];
  let pl: Placement | null = null;
  const runSuggest = () => {
    const s = suggest(prep, size);
    heat = s.green;
    pl = s.best?.placement ?? null;
  };
  runSuggest();

  // View transform: plot frame (metres) to SVG pixels.
  const xs = site.plot.map((p) => p[0]);
  const ys = site.plot.map((p) => p[1]);
  const pad = 6;
  const [x0, x1, y0, y1] = [
    Math.min(...xs) - pad,
    Math.max(...xs) + pad,
    Math.min(...ys) - pad,
    Math.max(...ys) + pad,
  ];
  const S = Math.min(W / (x1 - x0), H / (y1 - y0));
  const ox = (W - (x1 - x0) * S) / 2;
  const oy = (H - (y1 - y0) * S) / 2;
  const X = (x: number) => ox + (x - x0) * S;
  const Y = (y: number) => H - (oy + (y - y0) * S);
  const fromScreen = (px: number, py: number): [number, number] => [
    (px - ox) / S + x0,
    (H - py - oy) / S + y0,
  ];
  const path = (p: Polygon) =>
    `M${p.map((q) => `${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join("L")}Z`;

  const background = (): string => {
    const parts: string[] = [`<rect width="${W}" height="${H}" fill="#fbfaf7"/>`];
    for (const a of site.publicAreas ?? [])
      parts.push(`<path d="${path(a)}" fill="#e4e2dc" stroke="#cfccc4"/>`);
    parts.push(`<path d="${path(site.plot)}" fill="#f1f6ec" stroke="#222" stroke-width="2"/>`);
    for (const part of prep.yard.region)
      parts.push(
        `<path d="${path(part.outer)}${part.holes.map((h) => path(h)).join("")}" fill="#cfe8c0" fill-opacity="0.55" fill-rule="evenodd" stroke="#4c8a3a" stroke-dasharray="6 4"/>`,
      );
    // Zones where an exception depends on the position, shown on the plot only.
    for (const e of site.exclusions)
      for (const z of e.state === "depends-on-placement" ? (e.zones ?? []) : [])
        parts.push(`<path d="${path(z)}" fill="url(#hatch)" clip-path="url(#plotclip)"/>`);
    for (const c of site.obstacles?.cells ?? []) {
      if (c.heightM < 1) continue;
      const s = (site.obstacles?.cellM ?? 0.5) * S;
      const col =
        c.kind === "overhang"
          ? "#8a63d2"
          : c.heightM >= 2.5
            ? "#d9534f"
            : c.heightM >= 1.5
              ? "#e8a33d"
              : "#e6d24c";
      parts.push(
        `<rect x="${(X(c.at[0]) - s / 2).toFixed(1)}" y="${(Y(c.at[1]) - s / 2).toFixed(1)}" width="${s.toFixed(1)}" height="${s.toFixed(1)}" fill="${col}" fill-opacity="0.55"/>`,
      );
    }
    for (const s of site.structures)
      parts.push(
        `<path d="${path(s.outline)}" fill="none" stroke="#7b4aa0" stroke-dasharray="4 3"/>`,
      );
    for (const b of site.buildings)
      parts.push(`<path d="${path(b.outline)}" fill="#c9c6bf" stroke="#77736a"/>`);
    for (const h of site.house)
      parts.push(`<path d="${path(h.outline)}" fill="#c98b5a" stroke="#6d4528"/>`);
    for (const [a, b] of site.access.entries)
      parts.push(
        `<line x1="${X(a[0])}" y1="${Y(a[1])}" x2="${X(b[0])}" y2="${Y(b[1])}" stroke="#1f6fd1" stroke-width="6" stroke-linecap="round"/>`,
      );
    for (const c of heat)
      parts.push(
        `<circle cx="${X(c.x).toFixed(1)}" cy="${Y(c.y).toFixed(1)}" r="1.6" fill="#2f7d32" fill-opacity="0.5"/>`,
      );
    return parts.join("");
  };

  el.innerHTML = `
    <div class="cp-tools">
      <button data-size="single" class="btn small">Single 3 × 5 m</button>
      <button data-size="double" class="btn small">Double 6 × 5 m</button>
      <button data-act="rotate" class="btn small">Rotate</button>
      <button data-act="suggest" class="btn small">Best spot</button>
      <span class="small muted" id="cp-size"></span>
    </div>
    <div class="cp-stage"><svg id="cp-svg" viewBox="0 0 ${W} ${H}" style="touch-action:none">
      <defs><clipPath id="plotclip"><path d="${path(site.plot)}"/></clipPath><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#9a5" stroke-width="1.5"/></pattern></defs>
      <g id="cp-bg">${background()}</g><g id="cp-fg"></g></svg></div>
    <div class="small muted cp-legend">Drag the carport to move it, drag its corner to resize. Green dashed: back-yard area (from 1 m behind the house front; a permit is always needed in front of it). Blue: way in for a car. Hatched: zone where an exception depends on the position (archaeology from 50 m², safety zones). Green dots: spots where this size likely meets the permit-free rules (car access and data checks still apply). Coloured squares: trees and objects from the laser scan. Height is fixed at ${CARPORT_HEIGHT_M} m.</div>
    <div id="cp-verdict"></div>`;

  const svg = el.querySelector<SVGSVGElement>("#cp-svg")!;
  const fg = el.querySelector<SVGGElement>("#cp-fg")!;
  const verdictEl = el.querySelector<HTMLElement>("#cp-verdict")!;
  const sizeEl = el.querySelector<HTMLElement>("#cp-size")!;

  let verdict: CarportVerdict | null = null;
  const render = () => {
    if (!pl) {
      fg.innerHTML = "";
      verdictEl.innerHTML = `<div class="cp-headline" style="border-color:${COLOUR.red}"><b style="color:${COLOUR.red}">No spot found</b><div class="small">There is no place on this plot where a ${fmtM(size.widthM)} × ${fmtM(size.lengthM)} m carport fits clear of buildings and can be reached by car.</div></div>`;
      sizeEl.textContent = "";
      return;
    }
    verdict = evaluate(prep, pl);
    const r = rectangle(pl);
    const col = COLOUR[verdict.colour];
    const corner = r[2]!;
    fg.innerHTML = `<path id="cp-rect" d="${path(r)}" fill="${col}" fill-opacity="0.28" stroke="${col}" stroke-width="3" style="cursor:move"/>
      <line x1="${X(r[0]![0])}" y1="${Y(r[0]![1])}" x2="${X(r[2]![0])}" y2="${Y(r[2]![1])}" stroke="${col}" stroke-opacity="0.5" pointer-events="none"/>
      <line x1="${X(r[1]![0])}" y1="${Y(r[1]![1])}" x2="${X(r[3]![0])}" y2="${Y(r[3]![1])}" stroke="${col}" stroke-opacity="0.5" pointer-events="none"/>
      <circle id="cp-handle" cx="${X(corner[0])}" cy="${Y(corner[1])}" r="8" fill="white" stroke="${col}" stroke-width="3" style="cursor:nwse-resize"/>`;
    sizeEl.textContent = `${fmtM(pl.widthM)} × ${fmtM(pl.lengthM)} m = ${fmtM(pl.widthM * pl.lengthM)} m², ${CARPORT_HEIGHT_M} m high`;
    verdictEl.innerHTML = renderVerdict(verdict);
  };

  const toSvg = (ev: PointerEvent): [number, number] => {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const m = svg.getScreenCTM();
    const p = m ? pt.matrixTransform(m.inverse()) : pt;
    return fromScreen(p.x, p.y);
  };
  let drag: { mode: "move" | "resize"; dx: number; dy: number } | null = null;
  let frame = 0;
  svg.addEventListener("pointerdown", (ev) => {
    if (!pl) return;
    const t = ev.target as Element;
    const [mx, my] = toSvg(ev);
    if (t.id === "cp-handle") drag = { mode: "resize", dx: 0, dy: 0 };
    else if (t.id === "cp-rect") drag = { mode: "move", dx: mx - pl.x, dy: my - pl.y };
    else return;
    svg.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!drag || !pl) return;
    const [mx, my] = toSvg(ev);
    if (drag.mode === "move") {
      pl = { ...pl, x: snap(mx - drag.dx), y: snap(my - drag.dy) };
    } else {
      // Keep the bottom-left corner fixed; the handle sets the opposite corner.
      const r = rectangle(pl);
      const left = r[0]![0];
      const bottom = r[0]![1];
      const wAlong = clamp(
        snap(mx - left),
        pl.rotation === 0 ? CARPORT_LIMITS.minWidthM : CARPORT_LIMITS.minLengthM,
        pl.rotation === 0 ? CARPORT_LIMITS.maxWidthM : CARPORT_LIMITS.maxLengthM,
      );
      const hInto = clamp(
        snap(my - bottom),
        pl.rotation === 0 ? CARPORT_LIMITS.minLengthM : CARPORT_LIMITS.minWidthM,
        pl.rotation === 0 ? CARPORT_LIMITS.maxLengthM : CARPORT_LIMITS.maxWidthM,
      );
      const widthM = pl.rotation === 0 ? wAlong : hInto;
      const lengthM = pl.rotation === 0 ? hInto : wAlong;
      pl = { ...pl, widthM, lengthM, x: left + wAlong / 2, y: bottom + hInto / 2 };
    }
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        render();
      });
  });
  const end = () => {
    if (drag?.mode === "resize" && pl) {
      size = { widthM: pl.widthM, lengthM: pl.lengthM };
      heat = suggest(prep, size).green;
      el.querySelector("#cp-bg")!.innerHTML = background();
    }
    drag = null;
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);

  el.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((b) =>
    b.addEventListener("click", () => {
      size = { ...CARPORT_PRESETS[b.dataset.size as "single" | "double"] };
      runSuggest();
      el.querySelector("#cp-bg")!.innerHTML = background();
      render();
    }),
  );
  el.querySelector('[data-act="rotate"]')?.addEventListener("click", () => {
    if (!pl) return;
    pl = { ...pl, rotation: pl.rotation === 0 ? 90 : 0 };
    render();
  });
  el.querySelector('[data-act="suggest"]')?.addEventListener("click", () => {
    runSuggest();
    el.querySelector("#cp-bg")!.innerHTML = background();
    render();
  });
  render();
  return { dispose: () => (el.innerHTML = "") };
}

const snap = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmtM = (v: number) => (Math.round(v * 10) / 10).toString().replace(".", ",");

function renderVerdict(v: CarportVerdict): string {
  const col = COLOUR[v.colour];
  const groups = GROUPS.map(([g, title]) => {
    const list = v.checks.filter((c) => c.group === g);
    if (!list.length) return "";
    return `<div class="cp-group"><h4>${esc(title)}</h4>${list
      .map((c) => {
        const rule = c.ruleId ? RULES.rules.find((r) => r.id === c.ruleId) : undefined;
        const doc = rule ? RULES.documents[rule.document] : undefined;
        return `<div class="cp-check ${c.outcome}"><span class="cp-icon">${ICON[c.outcome]}</span><div><div>${esc(c.label)}</div><div class="small muted">${esc(c.detail)}</div>${
          rule && doc
            ? `<details class="small"><summary>${esc(doc.title)}, art. ${esc(rule.article)}</summary><blockquote lang="nl">"${esc(rule.quote)}"</blockquote><div class="muted">${esc(rule.plain)} Verified ${esc(doc.verifiedOn)} against ${esc(doc.verifiedExpressionId.split("/").pop() ?? "")}.</div></details>`
            : ""
        }</div></div>`;
      })
      .join("")}</div>`;
  }).join("");
  return `<div class="cp-headline" style="border-color:${col}">
      <b style="color:${col}">${esc(v.headline)}</b>
      ${v.warnings.map((w) => `<div class="small cp-warn">⚠ ${esc(w.text)}</div>`).join("")}
    </div>${groups}`;
}
