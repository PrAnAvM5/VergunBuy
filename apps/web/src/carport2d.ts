/**
 * "Carport 2D": the plot from above, in its own frame (street at the bottom). Numbered good spots
 * (#1, #2, ...), the selected carport to drag and resize, the car's swept path, and the car
 * driving in and out.
 */
import type { PlotContext } from "@vergunbuy/data";
import {
  CARPORT_LIMITS,
  POST_M,
  carCorners,
  rectangle,
  type Car,
  type Placement,
  type Polygon,
  type Pose,
} from "@vergunbuy/engine";
import {
  COLOUR,
  bindControls,
  controlsHtml,
  fmtM,
  getSession,
  place,
  select,
  verdictHtml,
  type Session,
} from "./carportSession.ts";
import { esc } from "./format.ts";
import { planScene } from "./plan2d.ts";

export interface CarportView {
  dispose(): void;
}

export async function mountCarport2D(el: HTMLElement, ctx: PlotContext): Promise<CarportView> {
  const got = await getSession(ctx);
  if ("gate" in got) {
    el.innerHTML = `<div class="carport-msg"><h3>No carport check for this home</h3><p>${esc(got.gate)}</p></div>`;
    return { dispose: () => (el.innerHTML = "") };
  }
  const s: Session = got;
  const site = s.site;

  // The 2D plan itself (same drawing as the "2D plan" tab, without dimension lines), with more
  // room below the plot: the car comes from the street.
  const scene = planScene(ctx, { showDims: false, padBottom: 13 });
  const W = scene.W;
  const H = scene.H;
  const S = scene.scale;
  const xs = site.plot.map((p) => p[0]);
  const ys = site.plot.map((p) => p[1]);
  const X = scene.tx;
  const Y = scene.ty;
  const fromScreen = scene.fromSvg;
  const path = (p: Polygon) =>
    `M${p.map((q) => `${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join("L")}Z`;
  const line = (a: readonly [number, number], b: readonly [number, number], attrs: string) =>
    `<line x1="${X(a[0]).toFixed(1)}" y1="${Y(a[1]).toFixed(1)}" x2="${X(b[0]).toFixed(1)}" y2="${Y(b[1]).toFixed(1)}" ${attrs}/>`;

  const background = (): string => {
    const parts: string[] = [scene.body];
    // Back yard (permit-free area) and zones where an exception depends on the position.
    for (const part of s.prep.yard.region)
      parts.push(
        `<path d="${path(part.outer)}${part.holes.map((h) => path(h)).join("")}" fill="#cfe8c0" fill-opacity="0.3" fill-rule="evenodd" stroke="#4c8a3a" stroke-dasharray="6 4" pointer-events="none"/>`,
      );
    for (const e of site.exclusions)
      for (const z of e.state === "depends-on-placement" ? (e.zones ?? []) : [])
        parts.push(
          `<path d="${path(z)}" fill="url(#cp-hatch)" clip-path="url(#cp-plotclip)" pointer-events="none"/>`,
        );
    // Without plot-line data, show where a car could come in, as before.
    if (!site.boundary) {
      for (const [a, b] of site.access.frontage)
        parts.push(
          line(
            a,
            b,
            `stroke="#1f6fd1" stroke-width="4" stroke-dasharray="6 5" stroke-opacity="0.7"`,
          ),
        );
      for (const [a, b] of site.access.entries)
        parts.push(
          line(
            a,
            b,
            `stroke="#1f6fd1" stroke-width="7" stroke-linecap="round" ${site.access.level === "registered" ? "" : 'stroke-dasharray="10 6"'}`,
          ),
        );
    }
    return parts.join("");
  };

  const carSvg = (car: Car, p: Pose, fill: string, stroke: string, id = "") => {
    const t = `translate(${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}) rotate(${((p.a * 180) / Math.PI).toFixed(1)}) scale(${S.toFixed(3)})`;
    const w = car.w;
    return `<g ${id ? `id="${id}"` : ""} pointer-events="none" transform="${t}">
      <rect x="${-w / 2}" y="${-car.nose}" width="${w}" height="${car.l}" rx="0.45" fill="${fill}" stroke="${stroke}" stroke-width="0.08"/>
      <rect x="${-w / 2 + 0.2}" y="${-car.nose + 1.05}" width="${w - 0.4}" height="0.55" rx="0.12" fill="#2a3440" opacity=".75"/>
      <rect x="${-w / 2 + 0.25}" y="${car.ro - 0.95}" width="${w - 0.5}" height="0.4" rx="0.1" fill="#2a3440" opacity=".6"/>
      <rect class="revlight" x="${-w / 2 + 0.15}" y="${car.ro - 0.12}" width="${w - 0.3}" height="0.1" fill="#fff" opacity="${p.rev ? 1 : 0}"/>
    </g>`;
  };

  const sweptPath = (car: Car, poses: Pose[]) => {
    let d = "";
    for (let i = 0; i < poses.length; i += 2) {
      const c = carCorners(car, poses[i]!.x, poses[i]!.y, poses[i]!.a);
      d += `M${X(c[0]!).toFixed(1)},${Y(c[1]!).toFixed(1)}L${X(c[2]!).toFixed(1)},${Y(c[3]!).toFixed(1)}L${X(c[4]!).toFixed(1)},${Y(c[5]!).toFixed(1)}L${X(c[6]!).toFixed(1)},${Y(c[7]!).toFixed(1)}Z`;
    }
    return d;
  };
  const centreLine = (car: Car, poses: Pose[]) =>
    poses
      .map(
        (p) =>
          `${X(p.x + car.bodyC * Math.sin(p.a)).toFixed(1)},${Y(p.y + car.bodyC * Math.cos(p.a)).toFixed(1)}`,
      )
      .join(" ");

  const foreground = (): string => {
    const car = s.prep.vehicle.car;
    const parts: string[] = [];
    // The other good spots, numbered.
    s.opts.forEach((o, i) => {
      if (i === s.sel) return;
      const r = rectangle(o.placement);
      const col = COLOUR[o.verdict.colour];
      const c = [X(o.placement.x), Y(o.placement.y)];
      parts.push(
        `<g class="cp-opt" data-opt="${i}" style="cursor:pointer"><path d="${path(r)}" fill="#fff" fill-opacity="0.01" stroke="${col}" stroke-width="2" stroke-dasharray="6 4"/><circle cx="${c[0]!.toFixed(1)}" cy="${c[1]!.toFixed(1)}" r="12" fill="${col}"/><text x="${c[0]!.toFixed(1)}" y="${(c[1]! + 4.5).toFixed(1)}" font-size="13" font-weight="700" text-anchor="middle" fill="#fff">${o.n}</text></g>`,
      );
    });
    const v = s.verdict;
    if (!s.pl || !v) return parts.join("");
    const col = COLOUR[v.colour];
    // Swept path of the selected bay (the whole car body, with its clearance shown as the outline).
    const B = v.access.bays[s.bay];
    if (B?.route) {
      parts.push(
        `<path d="${sweptPath(car, B.route.poses)}" fill="#1f6fd1" fill-opacity="0.13" pointer-events="none"/>`,
      );
      parts.push(
        `<polyline points="${centreLine(car, B.route.poses)}" fill="none" stroke="#1f6fd1" stroke-width="1.6" stroke-dasharray="6 4" pointer-events="none"/>`,
      );
      // Where the car crosses the plot line: the exit it uses.
      const cr = B.route.crossing;
      if (cr.length >= 2) {
        let best: [number, number, number] = [0, 0, -1];
        for (let i = 0; i < cr.length; i++)
          for (let j = i + 1; j < cr.length; j++) {
            const d = Math.hypot(cr[i]![0] - cr[j]![0], cr[i]![1] - cr[j]![1]);
            if (d > best[2]) best = [i, j, d];
          }
        const a = cr[best[0]]!;
        const b = cr[best[1]]!;
        const label = v.access.via === "existing" ? "existing exit" : "new exit (exit permit)";
        parts.push(
          line(
            a,
            b,
            `stroke="#f2b134" stroke-width="5" stroke-linecap="round" pointer-events="none"`,
          ),
        );
        // The label sits outside the plot, beyond the exit.
        const mx = (a[0] + b[0]) / 2;
        const my = (a[1] + b[1]) / 2;
        const ccx = xs.reduce((t, v) => t + v, 0) / xs.length;
        const ccy = ys.reduce((t, v) => t + v, 0) / ys.length;
        const dl = Math.hypot(mx - ccx, my - ccy) || 1;
        const lx = mx + ((mx - ccx) / dl) * 2.2;
        const ly = my + ((my - ccy) / dl) * 2.2;
        parts.push(
          `<text x="${X(lx).toFixed(1)}" y="${(Y(ly) + 4).toFixed(1)}" font-size="12" text-anchor="middle" fill="#8a5a00" stroke="#fff" stroke-width="3" paint-order="stroke" pointer-events="none">${label} · car uses ${fmtM(best[2])} m</text>`,
        );
      }
    }
    // The carport.
    const r = rectangle(s.pl);
    parts.push(
      `<path id="cp-rect" d="${path(r)}" fill="${col}" fill-opacity="0.25" stroke="${col}" stroke-width="3" style="cursor:move"/>`,
    );
    const P = POST_M;
    for (const [px, py] of [
      [r[0]![0], r[0]![1]],
      [r[1]![0] - P, r[1]![1]],
      [r[3]![0], r[3]![1] - P],
      [r[2]![0] - P, r[2]![1] - P],
    ] as const)
      parts.push(
        `<rect x="${X(px).toFixed(1)}" y="${Y(py + P).toFixed(1)}" width="${Math.max(2, P * S).toFixed(1)}" height="${Math.max(2, P * S).toFixed(1)}" fill="#222" pointer-events="none"/>`,
      );
    if (s.sel !== null) {
      const o = s.opts[s.sel]!;
      parts.push(
        `<g pointer-events="none"><circle cx="${X(r[3]![0]).toFixed(1)}" cy="${Y(r[3]![1]).toFixed(1)}" r="12" fill="${col}" stroke="#fff" stroke-width="2"/><text x="${X(r[3]![0]).toFixed(1)}" y="${(Y(r[3]![1]) + 4.5).toFixed(1)}" font-size="13" font-weight="700" text-anchor="middle" fill="#fff">${o.n}</text></g>`,
      );
    }
    // Parked cars (the selected bay's car is hidden while it drives).
    v.access.bays.forEach((b, i) => {
      if (i === s.bay && s.moving) return;
      if (!v.access.fit.fits) return;
      parts.push(
        i === s.bay
          ? carSvg(car, b.parked, b.route ? "#cfe0f7" : "#f6d3d0", b.route ? "#1f6fd1" : "#b3261e")
          : carSvg(car, b.parked, "#fff", "#555"),
      );
    });
    if (s.moving) parts.push(carSvg(car, s.moving, "#cfe0f7", "#1f6fd1", "cp-movcar"));
    const corner = r[2]!;
    parts.push(
      `<circle id="cp-handle" cx="${X(corner[0]).toFixed(1)}" cy="${Y(corner[1]).toFixed(1)}" r="8" fill="#fff" stroke="${col}" stroke-width="3" style="cursor:nwse-resize"/>`,
    );
    return parts.join("");
  };

  el.innerHTML = `
    <div id="cp-controls"></div>
    <div class="cp-stage"><svg id="cp-svg" viewBox="0 0 ${W} ${H}" style="touch-action:none">
      <defs><clipPath id="cp-plotclip"><path d="${path(site.plot)}"/></clipPath><pattern id="cp-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#9a5" stroke-width="1.5"/></pattern></defs>
      <g id="cp-bg">${background()}</g><g id="cp-fg"></g></svg></div>
    <div class="small muted cp-legend">The plan is the same as the 2D plan tab. Numbered: hand-picked spots (green: permit-free; amber: possible with a condition, such as a permit, a new exit, or shrubs to clear). Drag the carport to move it, drag its corner to resize: it turns red over a tree (2.5 m or higher) and amber over shrubs or something solid. The street side of the plot line shows what stands on it: orange = registered driveway crossing, blue dashed = open, green = hedge, dark grey = fence or wall, purple dashed = unknown. Light blue: the space the car body sweeps on the way in, keeping ${fmtM(s.params.clearanceM)} m from walls and tree crowns. Green dashed: back yard.</div>
    <div id="cp-verdict"></div>`;
  const svg = el.querySelector<SVGSVGElement>("#cp-svg")!;
  const fg = el.querySelector<SVGGElement>("#cp-fg")!;
  const controls = el.querySelector<HTMLElement>("#cp-controls")!;
  const verdictEl = el.querySelector<HTMLElement>("#cp-verdict")!;

  let shownVerdict: unknown = null;
  let shownMoving = false;
  const render = () => {
    // While the car drives, only move the car.
    const mov = el.querySelector<SVGGElement>("#cp-movcar");
    if (s.anim && s.moving && shownMoving && shownVerdict === s.verdict && mov) {
      const p = s.moving;
      mov.setAttribute(
        "transform",
        `translate(${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}) rotate(${((p.a * 180) / Math.PI).toFixed(1)}) scale(${S.toFixed(3)})`,
      );
      mov.querySelector(".revlight")?.setAttribute("opacity", p.rev ? "1" : "0");
      return;
    }
    fg.innerHTML = foreground();
    shownMoving = !!s.moving;
    if (shownVerdict !== s.verdict || !s.anim) {
      controls.innerHTML = controlsHtml(s);
      bindControls(controls, s);
      verdictEl.innerHTML = verdictHtml(s);
    }
    shownVerdict = s.verdict;
  };
  let lastParams = s.params;
  const onChange = () => {
    if (lastParams !== s.params) {
      lastParams = s.params;
      el.querySelector("#cp-bg")!.innerHTML = background();
    }
    render();
  };
  s.listeners.add(onChange);

  const toPlan = (ev: PointerEvent): [number, number] => {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const m = svg.getScreenCTM();
    const p = m ? pt.matrixTransform(m.inverse()) : pt;
    return fromScreen(p.x, p.y);
  };
  let drag: { mode: "move" | "resize"; dx: number; dy: number } | null = null;
  let pending: Placement | null = null;
  let frame = 0;
  svg.addEventListener("pointerdown", (ev) => {
    const t = ev.target as Element;
    const opt = t.closest("[data-opt]");
    if (opt) {
      select(s, Number(opt.getAttribute("data-opt")));
      return;
    }
    if (!s.pl) return;
    const [mx, my] = toPlan(ev);
    if (t.id === "cp-handle") drag = { mode: "resize", dx: 0, dy: 0 };
    else if (t.id === "cp-rect") drag = { mode: "move", dx: mx - s.pl.x, dy: my - s.pl.y };
    else return;
    svg.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!drag || !s.pl) return;
    const cur = pending ?? s.pl;
    const [mx, my] = toPlan(ev);
    if (drag.mode === "move") pending = { ...cur, x: snap(mx - drag.dx), y: snap(my - drag.dy) };
    else {
      // The bottom-left corner stays; the handle sets the opposite corner.
      const r = rectangle(cur);
      const left = r[0]![0];
      const bottom = r[0]![1];
      const rot0 = cur.rotation === 0;
      const along = clamp(
        snap(mx - left),
        rot0 ? CARPORT_LIMITS.minWidthM : CARPORT_LIMITS.minLengthM,
        rot0 ? CARPORT_LIMITS.maxWidthM : CARPORT_LIMITS.maxLengthM,
      );
      const into = clamp(
        snap(my - bottom),
        rot0 ? CARPORT_LIMITS.minLengthM : CARPORT_LIMITS.minWidthM,
        rot0 ? CARPORT_LIMITS.maxLengthM : CARPORT_LIMITS.maxWidthM,
      );
      pending = {
        ...cur,
        widthM: rot0 ? along : into,
        lengthM: rot0 ? into : along,
        x: left + along / 2,
        y: bottom + into / 2,
      };
    }
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (pending) {
          const p = pending;
          pending = null;
          s.sizeKey = "custom";
          place(s, p);
        }
      });
  });
  const end = () => {
    drag = null;
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);

  render();
  return {
    dispose: () => {
      s.listeners.delete(onChange);
      if (frame) cancelAnimationFrame(frame);
      el.innerHTML = "";
    },
  };
}

const snap = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
