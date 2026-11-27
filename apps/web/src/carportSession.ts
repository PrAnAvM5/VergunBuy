/**
 * Carport planner state, shared by the "Carport 2D" and "Carport 3D" tabs: the site, the car
 * (adjustable), the numbered options, the placed carport and its verdict, and the animation.
 * Also the controls and the verdict panel, which look the same in both tabs.
 */
import type { PlotContext } from "@vergunbuy/data";
import { carportSite } from "@vergunbuy/data";
import {
  CARPORT_LIMITS,
  CARPORT_PRESETS,
  DEFAULT_VEHICLE,
  driveOut,
  evaluate,
  options,
  prepare,
  RuleSet,
  type CarportCheck,
  type CarportOption,
  type CarportSite,
  type CarportVerdict,
  type CurrentVersion,
  type Placement,
  type Pose,
  type Prepared,
  type VehicleParams,
} from "@vergunbuy/engine";
import rulesJson from "../../../rulesets/woensdrecht/carport/2026-11-24.json";
import { esc } from "./format.ts";

export const RULES = RuleSet.parse(rulesJson);
export const COLOUR = { green: "#2f7d32", amber: "#b26a00", red: "#b3261e" } as const;
export const ZONE_TEXT = {
  back: "back yard",
  side: "beside the house",
  front: "front yard",
} as const;

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

/** Lets the browser paint (a spinner) before heavy work on the main thread. */
const yieldToPaint = () => new Promise<void>((r) => setTimeout(r, 30));

export type SizeKey = "single" | "double";

export interface Session {
  ctx: PlotContext;
  site: CarportSite;
  prep: Prepared;
  params: VehicleParams;
  sizeKey: SizeKey | "custom";
  size: { widthM: number; lengthM: number };
  opts: CarportOption[];
  /** Index into opts of the selected option; null when the carport was moved by hand. */
  sel: number | null;
  pl: Placement | null;
  verdict: CarportVerdict | null;
  bay: number;
  busy: string | null;
  message: { text: string; bad: boolean } | null;
  listeners: Set<() => void>;
  /** The animated car's pose, or null when not animating. */
  moving: Pose | null;
  anim: number;
  /** Scanned shrubs on the plot the person marked as cleared (obstacle ids). */
  cleared: Set<string>;
  /** The person checked on site that the kerb is lowered where the car crosses. */
  kerbConfirmed: boolean;
}

const sessions = new WeakMap<PlotContext, Promise<Session | { gate: string }>>();

export function getSession(ctx: PlotContext): Promise<Session | { gate: string }> {
  let s = sessions.get(ctx);
  if (!s) {
    s = build(ctx);
    sessions.set(ctx, s);
  }
  return s;
}

async function build(ctx: PlotContext): Promise<Session | { gate: string }> {
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
  if (!site) return { gate: gate ?? "No carport check for this home." };
  await yieldToPaint();
  const prep = prepare(site, DEFAULT_VEHICLE);
  const s: Session = {
    ctx,
    site,
    prep,
    params: { ...DEFAULT_VEHICLE },
    sizeKey: "single",
    size: { ...CARPORT_PRESETS.single },
    opts: [],
    sel: null,
    pl: null,
    verdict: null,
    bay: 0,
    busy: null,
    message: null,
    listeners: new Set(),
    moving: null,
    anim: 0,
    cleared: new Set(),
    kerbConfirmed: false,
  };
  refreshOptions(s);
  return s;
}

function refreshOptions(s: Session): void {
  s.opts = options(s.prep, s.size, 6, { kerbConfirmed: s.kerbConfirmed });
  select(s, s.opts.length ? 0 : null, false);
  if (!s.opts.length) {
    // Nothing to offer: still put a carport in the garden, so the user can drag it and see why.
    const xs = s.site.plot.map((p) => p[0]);
    const ys = s.site.plot.map((p) => p[1]);
    const pl: Placement = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: Math.max(...ys) - s.size.lengthM / 2 - 1,
      rotation: 0,
      ...s.size,
    };
    s.pl = pl;
    s.verdict = reevaluate(s, pl);
    s.message = {
      text: "No good spot found for this size: drag the carport to see what stands in the way.",
      bad: true,
    };
  }
}

export function notify(s: Session): void {
  for (const l of s.listeners) l();
}

export function select(s: Session, i: number | null, tell = true): void {
  stopAnim(s);
  s.sel = i;
  s.bay = 0;
  s.message = null;
  const o = i === null ? undefined : s.opts[i];
  s.pl = o ? o.placement : null;
  s.verdict = o ? reevaluate(s, o.placement) : null;
  if (tell) notify(s);
}

/** Scanned objects that can be marked as removed: everything except trees (a tall object read
 *  as a plant or unclear, or branches from next door). */
export function clearable(s: Session, id: string): boolean {
  const o = s.ctx.obstacles?.obstacles.find((x) => x.id === id);
  if (!o) return false;
  if (o.kind === "medium") return true;
  if (o.kind === "overhang") return false;
  return o.material === "solid";
}

/** The site with the objects the person removed taken out. */
function siteWithout(s: Session): CarportSite {
  if (!s.site.obstacles || !s.cleared.size) return s.site;
  return {
    ...s.site,
    obstacles: {
      ...s.site.obstacles,
      cells: s.site.obstacles.cells.filter((c) => !(c.id && s.cleared.has(c.id))),
    },
  };
}

/** Checks a spot; notes what the person chose to remove. */
function reevaluate(s: Session, pl: Placement): CarportVerdict {
  const v = evaluate(s.prep, pl, { cleared: s.cleared, kerbConfirmed: s.kerbConfirmed });
  const gone = (s.ctx.obstacles?.obstacles ?? []).filter((o) => s.cleared.has(o.id));
  if (gone.length) {
    const tall = gone.some((o) => o.kind !== "medium");
    const solid = gone.some((o) => o.material === "solid");
    v.warnings.push({
      id: "removed",
      text: `This assumes you remove the ${gone.length === 1 ? "object" : `${gone.length} objects`} you marked (about ${Math.round(gone.reduce((t, o) => t + o.areaM2, 0))} m²). Shrubs on your own plot need no permit${solid || tall ? "; for a shed, wall or other building, check whether taking it down needs one" : ""}. Trees cannot be removed here.`,
    });
  }
  return v;
}

/** Works out the car's worlds again without the removed objects, then rechecks. */
async function rebuild(s: Session, refresh: boolean): Promise<void> {
  stopAnim(s);
  s.busy = "Checking again without those objects…";
  notify(s);
  await yieldToPaint();
  s.prep = prepare(siteWithout(s), s.params);
  s.busy = null;
  if (refresh) {
    const custom = s.sel === null ? s.pl : null;
    refreshOptions(s);
    if (custom) place(s, custom);
  } else if (s.pl) s.verdict = reevaluate(s, s.pl);
  notify(s);
}

/** Marks a scanned object as removed (or not) and checks the carport again. */
export function toggleCleared(s: Session, id: string): void {
  if (!clearable(s, id)) return;
  if (s.cleared.has(id)) s.cleared.delete(id);
  else s.cleared.add(id);
  void rebuild(s, false);
}

/** Every object except trees removed (or all back); the numbered spots are found again. */
export function clearAll(s: Session, on: boolean): void {
  s.cleared = new Set(
    on ? (s.ctx.obstacles?.obstacles ?? []).filter((o) => clearable(s, o.id)).map((o) => o.id) : [],
  );
  void rebuild(s, true);
}

/** "The kerb is lowered here, I checked": the spots are found again with that. */
export function setKerbConfirmed(s: Session, on: boolean): void {
  stopAnim(s);
  s.kerbConfirmed = on;
  const custom = s.sel === null ? s.pl : null;
  refreshOptions(s);
  if (custom) place(s, custom);
  notify(s);
}

/** Whether the "kerb is lowered" tick matters for this spot. */
export function kerbTickUseful(s: Session): boolean {
  const via = s.verdict?.access.via;
  return s.kerbConfirmed || via === "probable" || via === "unregistered" || via === "new-exit";
}

/** The carport moved or resized by hand. */
export function place(s: Session, pl: Placement): void {
  stopAnim(s);
  s.pl = pl;
  s.sel = null;
  s.message = null;
  s.verdict = reevaluate(s, pl);
  if (s.bay >= s.verdict.access.bays.length) s.bay = 0;
  notify(s);
}

export async function setSize(s: Session, key: SizeKey): Promise<void> {
  s.sizeKey = key;
  s.size = { ...CARPORT_PRESETS[key] };
  s.busy = "Finding good spots…";
  notify(s);
  await yieldToPaint();
  refreshOptions(s);
  s.busy = null;
  notify(s);
}

export async function setCar(s: Session, params: VehicleParams): Promise<void> {
  s.params = params;
  s.busy = "Recomputing every route for this car…";
  notify(s);
  await yieldToPaint();
  const custom = s.sel === null ? s.pl : null;
  s.prep = prepare(siteWithout(s), params);
  refreshOptions(s);
  if (custom) place(s, custom);
  s.busy = null;
  notify(s);
}

// ---------------------------------------------------------------------------------------------
// Animation: drive in along the planned route, drive out (reversing, turning where possible)
// ---------------------------------------------------------------------------------------------

export function stopAnim(s: Session): void {
  if (s.anim) cancelAnimationFrame(s.anim);
  s.anim = 0;
  s.moving = null;
}

const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function play(s: Session, mode: "in" | "out"): void {
  stopAnim(s);
  const v = s.verdict;
  const B = v?.access.bays[s.bay];
  const other = (v?.access.bays.length ?? 0) > 1 ? ` with bay ${2 - s.bay} occupied` : "";
  if (!v || !B?.route) {
    s.message = {
      text: !v
        ? "Place a carport first."
        : !s.prep.vehicle.existing && !s.prep.vehicle.any
          ? "No way in for a car is known on this plot (no registered exit and no road along it), so there is no route to show."
          : !v.access.fit.fits
            ? "The car does not fit in this carport."
            : "No route: the car cannot reach this spot with its turning circle and clearance.",
      bad: true,
    };
    notify(s);
    return;
  }
  let poses: Pose[];
  let text: string;
  if (mode === "in") {
    poses = B.route.poses;
    text = `In: from the street ${B.route.how}${other}.`;
  } else {
    const out = driveOut(v.access, s.bay);
    poses = out ? out.poses : [...B.route.poses].reverse().map((p) => ({ ...p, rev: true }));
    text = `Out: ${out ? out.text : "reverses all the way back along the way in"}${other}.`;
  }
  const cum = [0];
  for (let i = 1; i < poses.length; i++)
    cum.push(
      cum[i - 1]! + Math.hypot(poses[i]!.x - poses[i - 1]!.x, poses[i]!.y - poses[i - 1]!.y) + 1e-6,
    );
  const total = cum[cum.length - 1]!;
  const at = (d: number): Pose => {
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m]! <= d) lo = m;
      else hi = m;
    }
    const f = (d - cum[lo]!) / (cum[hi]! - cum[lo]! || 1);
    const a = poses[lo]!;
    const b = poses[hi]!;
    let da = (b.a - a.a) % (2 * Math.PI);
    if (da > Math.PI) da -= 2 * Math.PI;
    if (da < -Math.PI) da += 2 * Math.PI;
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      a: a.a + da * f,
      ...(a.rev ? { rev: true } : {}),
    };
  };
  const finish = () => {
    s.anim = 0;
    s.moving = mode === "out" ? at(total) : null;
    s.message = { text, bad: false };
    notify(s);
  };
  if (reduceMotion() || total < 0.1) {
    finish();
    return;
  }
  s.message = { text: mode === "in" ? `Driving in${other}…` : `Leaving${other}…`, bad: false };
  const start = performance.now();
  let last = start;
  let d = 0;
  const step = (now: number) => {
    const p = at(d);
    // About 9 m/s forwards and 6 m/s reversing: a typical drive-in takes 3–5 s.
    d += ((now - last) / 1000) * (p.rev ? 6 : 9);
    last = now;
    if (d >= total) {
      finish();
      return;
    }
    s.moving = at(d);
    notify(s);
    s.anim = requestAnimationFrame(step);
  };
  s.anim = requestAnimationFrame(step);
  notify(s);
}

// ---------------------------------------------------------------------------------------------
// Controls and verdict (same in both tabs)
// ---------------------------------------------------------------------------------------------

export const fmtM = (v: number) => (Math.round(v * 10) / 10).toString().replace(".", ",");

/** Two or three words for a spot: what it needs. */
export const STATUS_TEXT = (v: CarportVerdict): string => {
  if (v.colour === "green") return "permit-free";
  if (v.colour === "red") return "not possible";
  const permit = v.checks.some((c) => c.group === "permit-free" && c.outcome === "fail");
  const via = v.access.via;
  return via === "new-exit" || via === "unregistered"
    ? "new exit"
    : via === "through-barrier"
      ? "open hedge/fence"
      : permit
        ? "building permit"
        : "check on site";
};

export function controlsHtml(s: Session): string {
  const car = s.prep.vehicle.car;
  const bays = s.verdict?.access.bays.length ?? 0;
  const pl = s.pl;
  return `
    <div class="cp-tools">
      <button data-size="single" class="btn small" aria-pressed="${s.sizeKey === "single"}">Single 3 × 5</button>
      <button data-size="double" class="btn small" aria-pressed="${s.sizeKey === "double"}">Double 6 × 5</button>
      <label class="small">W <input class="cp-num" type="number" step="0.1" min="${CARPORT_LIMITS.minWidthM}" max="${CARPORT_LIMITS.maxWidthM}" data-dim="widthM" value="${pl ? fmtNum(pl.widthM) : ""}"></label>
      <label class="small">L <input class="cp-num" type="number" step="0.1" min="${CARPORT_LIMITS.minLengthM}" max="${CARPORT_LIMITS.maxLengthM}" data-dim="lengthM" value="${pl ? fmtNum(pl.lengthM) : ""}"> m</label>
      <label class="small">Angle <input class="cp-num" type="number" step="5" min="0" max="355" data-angle value="${pl ? Math.round(pl.rotation) : 0}">°</label>
      <button data-act="rotate" class="btn small" title="Turn the carport 90°">↻ 90°</button>
      ${
        (s.ctx.obstacles?.obstacles ?? []).some((o) => clearable(s, o.id))
          ? `<button data-act="clear-all" class="btn small" aria-pressed="${s.cleared.size > 0}" title="Remove every scanned object except trees">${s.cleared.size ? "Bring objects back" : "Remove all objects (not trees)"}</button>`
          : ""
      }
    </div>
    ${
      kerbTickUseful(s)
        ? `<div class="cp-tools"><label class="small cp-kerb" title="Look at the kerb where the yellow crossing meets the road: if it is lowered to road level (a driveway crossing), tick this."><input type="checkbox" data-act="kerb" ${s.kerbConfirmed ? "checked" : ""}> The kerb is lowered where the car crosses (I checked on site)</label></div>`
        : ""
    }
    <div class="cp-tools cp-opts">
      ${
        s.opts.length
          ? s.opts
              .map(
                (o, i) =>
                  `<button class="optbtn" data-opt="${i}" aria-pressed="${s.sel === i}"><span class="dot" style="background:${COLOUR[o.verdict.colour]}"></span>#${o.n} ${esc(STATUS_TEXT(o.verdict))}${o.placement.rotation % 90 ? ` · ${o.placement.rotation}°` : ""}</button>`,
              )
              .join("")
          : `<span class="small muted">No spot found for this size.</span>`
      }
    </div>
    <div class="cp-tools">
      ${bays > 1 ? `<span class="small">Bay</span><button class="btn small" data-bay="0" aria-pressed="${s.bay === 0}">1</button><button class="btn small" data-bay="1" aria-pressed="${s.bay === 1}">2</button>` : ""}
      <button class="btn small primary" data-act="in">▶ Drive in</button>
      <button class="btn small" data-act="out">◀ Drive out</button>
      <details class="cp-car"><summary>Car</summary>
        <div class="cp-car-grid">
          <label>Width (m) <input type="number" step="0.1" min="1.4" max="2.6" data-car="widthM" value="${s.params.widthM}"></label>
          <label>Length (m) <input type="number" step="0.1" min="3" max="6.5" data-car="lengthM" value="${s.params.lengthM}"></label>
          <label>Turning circle, outer corner (m) <input type="number" step="0.1" min="4.5" max="9" data-car="outerRadiusM" value="${s.params.outerRadiusM}"></label>
          <label>Clearance (m) <input type="number" step="0.1" min="0" max="1.5" data-car="clearanceM" value="${s.params.clearanceM}"></label>
        </div>
        <div class="small muted">Rear axle turns on ${fmtM(car.rt)} m. <button class="linkbtn" data-act="car-reset">Standard car</button></div>
      </details>
      <span class="small cp-msg ${s.message?.bad ? "bad" : ""}">${esc(s.message?.text ?? "")}</span>
    </div>
    ${s.busy ? `<div class="cp-busy"><div class="spinner"></div>${esc(s.busy)}</div>` : ""}`;
}
const fmtNum = (v: number) => String(Math.round(v * 10) / 10);

export function bindControls(root: HTMLElement, s: Session): void {
  root
    .querySelectorAll<HTMLButtonElement>("[data-size]")
    .forEach((b) => b.addEventListener("click", () => void setSize(s, b.dataset.size as SizeKey)));
  root
    .querySelectorAll<HTMLButtonElement>("[data-opt]")
    .forEach((b) => b.addEventListener("click", () => select(s, Number(b.dataset.opt))));
  root.querySelectorAll<HTMLButtonElement>("[data-bay]").forEach((b) =>
    b.addEventListener("click", () => {
      stopAnim(s);
      s.bay = Number(b.dataset.bay);
      s.message = null;
      notify(s);
    }),
  );
  root.querySelectorAll<HTMLInputElement>("[data-dim]").forEach((inp) =>
    inp.addEventListener("change", () => {
      if (!s.pl) return;
      const v = Number(inp.value.replace(",", "."));
      if (!Number.isFinite(v)) return;
      const key = inp.dataset.dim as "widthM" | "lengthM";
      const lim =
        key === "widthM"
          ? [CARPORT_LIMITS.minWidthM, CARPORT_LIMITS.maxWidthM]
          : [CARPORT_LIMITS.minLengthM, CARPORT_LIMITS.maxLengthM];
      s.sizeKey = "custom";
      place(s, { ...s.pl, [key]: Math.min(lim[1]!, Math.max(lim[0]!, v)) });
    }),
  );
  root.querySelector<HTMLInputElement>("[data-angle]")?.addEventListener("change", (ev) => {
    if (!s.pl) return;
    const v = Number((ev.target as HTMLInputElement).value.replace(",", "."));
    if (!Number.isFinite(v)) return;
    place(s, { ...s.pl, rotation: ((Math.round(v) % 360) + 360) % 360 });
  });
  root
    .querySelector('[data-act="clear-all"]')
    ?.addEventListener("click", () => clearAll(s, s.cleared.size === 0));
  root
    .querySelector<HTMLInputElement>('[data-act="kerb"]')
    ?.addEventListener("change", (ev) =>
      setKerbConfirmed(s, (ev.target as HTMLInputElement).checked),
    );
  root.querySelector('[data-act="rotate"]')?.addEventListener("click", () => {
    if (s.pl) place(s, { ...s.pl, rotation: (s.pl.rotation + 90) % 360 });
  });
  root.querySelector('[data-act="in"]')?.addEventListener("click", () => play(s, "in"));
  root.querySelector('[data-act="out"]')?.addEventListener("click", () => play(s, "out"));
  root.querySelector('[data-act="car-reset"]')?.addEventListener("click", (e) => {
    e.preventDefault();
    void setCar(s, { ...DEFAULT_VEHICLE });
  });
  root.querySelectorAll<HTMLInputElement>("[data-car]").forEach((inp) =>
    inp.addEventListener("change", () => {
      const v = Number(inp.value.replace(",", "."));
      const key = inp.dataset.car as keyof VehicleParams;
      if (!Number.isFinite(v)) return;
      const lim = {
        widthM: [1.4, 2.6],
        lengthM: [3, 6.5],
        outerRadiusM: [4.5, 9],
        clearanceM: [0, 1.5],
      }[key];
      const next = { ...s.params, [key]: Math.min(lim[1]!, Math.max(lim[0]!, v)) };
      if (next.outerRadiusM < next.lengthM * 0.8 + 0.5)
        next.outerRadiusM = next.lengthM * 0.8 + 0.5;
      void setCar(s, next);
    }),
  );
  // Keep the car settings open across re-renders.
  const det = root.querySelector<HTMLDetailsElement>(".cp-car");
  if (det) {
    det.open = carOpen;
    det.addEventListener("toggle", () => (carOpen = det.open));
  }
}
let carOpen = false;

const GROUPS: [CarportCheck["group"], string][] = [
  ["feasible", "Fits and car gets in"],
  ["permit-free", "Permit-free (art. 22.27)"],
  ["allowed-by-law", "Allowed by law (art. 22.36)"],
  ["exclusion", "Exceptions (22.28, 22.38, 22.39)"],
  ["technical", "Building rules (Bbl 2.25)"],
  ["freshness", "Rules up to date"],
];
const ICON = { pass: "✓", fail: "✕", unknown: "?" } as const;

export function verdictHtml(s: Session): string {
  const v = s.verdict;
  if (!v)
    return `<div class="cp-headline" style="border-color:${COLOUR.red}"><b style="color:${COLOUR.red}">No spot found</b></div>`;
  const col = COLOUR[v.colour];
  const o = s.sel !== null ? s.opts[s.sel] : undefined;
  const route = v.access.bays[s.bay]?.route;
  // What stands between this spot and green, one short line each.
  const open = v.checks.filter((c) => c.outcome !== "pass");
  const groups = GROUPS.map(([g, title]) => {
    const list = v.checks.filter((c) => c.group === g);
    if (!list.length) return "";
    const n = (o: string) => list.filter((c) => c.outcome === o).length;
    const tally = `${n("pass") ? `<span class="cp-t pass">✓${n("pass")}</span>` : ""}${n("unknown") ? `<span class="cp-t unknown">?${n("unknown")}</span>` : ""}${n("fail") ? `<span class="cp-t fail">✕${n("fail")}</span>` : ""}`;
    return `<details class="cp-group"${n("fail") ? " open" : ""}><summary>${esc(title)} ${tally}</summary>${list
      .map((c) => {
        const rule = c.ruleId ? RULES.rules.find((r) => r.id === c.ruleId) : undefined;
        const doc = rule ? RULES.documents[rule.document] : undefined;
        return `<div class="cp-check ${c.outcome}"><span class="cp-icon">${ICON[c.outcome]}</span><div><div>${esc(c.label)}</div><div class="small muted">${esc(c.detail)}</div>${
          rule && doc
            ? `<details class="small"><summary>${esc(doc.title)}, art. ${esc(rule.article)}</summary><blockquote lang="nl">"${esc(rule.quote)}"</blockquote><div class="muted">${esc(rule.plain)} Verified ${esc(doc.verifiedOn)}.</div></details>`
            : ""
        }</div></div>`;
      })
      .join("")}</details>`;
  }).join("");
  return `<div class="cp-headline" style="border-color:${col}">
      <b style="color:${col}">${o ? `#${o.n} · ` : ""}${esc(v.headline)}</b>
      ${route ? `<div class="small muted">Route ${esc(route.how)}, ~${Math.round(route.lengthM)} m</div>` : ""}
      ${open.length ? `<ul class="cp-needs">${open.map((c) => `<li class="${c.outcome}" title="${esc(c.detail)}">${ICON[c.outcome]} ${esc(c.label)}</li>`).join("")}</ul>` : ""}
      ${v.warnings.length ? `<details class="small cp-warn"><summary>⚠ ${v.warnings.length} note${v.warnings.length > 1 ? "s" : ""}</summary>${v.warnings.map((w) => `<div>${esc(w.text)}</div>`).join("")}</details>` : ""}
    </div>${groups}`;
}
