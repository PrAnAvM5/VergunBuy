/**
 * The address page: everything about one plot on one screen.
 * Main panel with three views of the same data (Map with aerial photo, 2D plan with the street
 * at the bottom, 3D model), and side cards: summary, surroundings per side, warnings, data
 * completeness and the Inspector. A click in the Map or 2D plan opens the object in the Inspector.
 */
import { ACCESS_TEXT, esc, FLAG_TEXT, HOUSE_TYPE_TEXT, m2, qualityCard } from "../format.ts";
import { bindAnswers, renderInspector } from "../inspector.ts";
import { AERIAL_YEARS, legend, type Layers } from "../plan.ts";
import { drawWorkspacePlan } from "../plan2d.ts";
import { lastRun, runCheck, type RunResult } from "../run.ts";
import type { SceneHandle } from "../scene3d.ts";
import type { MapHandle, OverlayId } from "../map.ts";
import { lookAround } from "../streetview.ts";
import { STRUCTURE_TEXT, SURFACE_TEXT, type PlotContext } from "@vergunbuy/data";

export type View = "carport" | "map" | "2d" | "3d" | "street";

let scene: SceneHandle | undefined;
let mapView: MapHandle | undefined;
const disposeMap = () => {
  mapView?.dispose();
  mapView = undefined;
};
/** Releases the 3D scene and the interactive map (WebGL contexts, listeners). */
export const disposeScene = () => {
  scene?.dispose();
  scene = undefined;
  disposeMap();
};

const VIA_TEXT: Record<string, string> = {
  voetpad: "the pavement",
  "verge on the road's parcel": "a verge that belongs to the road",
  "gras- en kruidachtigen": "a grass verge",
  heesters: "a shrub border",
  green: "public green",
};

const SIDE_TEXT: Record<string, string> = {
  front: "Front",
  rear: "Rear",
  left: "Left side",
  right: "Right side",
};

const sameQuery = (a: RunResult["query"], b: RunResult["query"]) =>
  a.postcode.replace(/\s/g, "").toUpperCase() === b.postcode.replace(/\s/g, "").toUpperCase() &&
  String(a.number) === String(b.number) &&
  (a.addition ?? "") === (b.addition ?? "");

/**
 * Loads three.js and builds the scene, with a clear message instead of an endless spinner when:
 *  - the site was updated while this page was open (the old 3D file no longer exists) → reload;
 *  - the browser cannot start WebGL (switched off, old GPU driver, some privacy modes);
 *  - the scene itself fails on unusual data (the error is logged for the developer view).
 */
const load3d = () => import("../scene3d.ts");

async function open3d(
  el: HTMLElement,
  ctx: PlotContext,
  stillWanted: () => boolean,
): Promise<SceneHandle | undefined> {
  let mod: Awaited<ReturnType<typeof load3d>>;
  try {
    mod = await load3d();
  } catch (err) {
    console.error(err);
    const key = "vergunbuy-reloaded-for-3d";
    if (!sessionStorageGet(key)) {
      sessionStorageSet(key, "1");
      location.reload();
      return undefined;
    }
    el.innerHTML = message3d(
      "The 3D view could not be loaded",
      "The site was probably updated while this page was open.",
      true,
    );
    return undefined;
  }
  if (!stillWanted()) return undefined;
  if (!mod.webglAvailable()) {
    el.innerHTML = message3d(
      "Your browser could not start 3D",
      "WebGL is switched off or not supported here. Try another browser, or turn on hardware acceleration in the browser settings.",
      false,
    );
    return undefined;
  }
  try {
    el.innerHTML = "";
    return mod.mountScene(el, ctx);
  } catch (err) {
    console.error(err);
    el.innerHTML = message3d(
      "The 3D model could not be built for this plot",
      `The map and 2D plan still work. Technical detail: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
    return undefined;
  }
}

/** Keeps the open tab in the address, so a reload or a shared link opens the same view. */
function rememberView(view: View): void {
  const [path = "", search = ""] = location.hash.split("?");
  const params = new URLSearchParams(search);
  if (view === "carport") params.delete("view");
  else params.set("view", view);
  const q = params.toString();
  history.replaceState(null, "", `${path}${q ? `?${q}` : ""}`);
}

const EXCLUSION_TEXT: Record<string, string> = {
  "ex-monument-2227": "Monuments",
  "ex-village-view-2227": "Protected village view",
  "ex-archaeology-2227": "Archaeology",
  "ex-monument-village-2236": "Monument or view (allowed-by-law route)",
  "ex-safety-2236": "External safety",
};
const STATE_PILL: Record<string, { cls: string; label: string }> = {
  clear: { cls: "ok", label: "Clear" },
  applies: { cls: "bad", label: "Applies" },
  "depends-on-placement": { cls: "warn", label: "Depends on position" },
  unknown: { cls: "warn", label: "Needs a check" },
};

/** Zoning plans, monuments and safety: the exceptions in the carport rules, from the registers. */
function legalCard(ctx: PlotContext): string {
  const l = ctx.legal;
  if (!l) return "";
  const plans = l.zoning.plans;
  return `<div class="card">
    <h3>Zoning plans and monuments</h3>
    <p class="small muted" style="margin:0 0 6px">${
      l.zoning.status === "missing"
        ? "The old zoning plans could not be loaded."
        : `${plans.length} binding zoning plan(s): ${plans.map((p) => esc(p.name)).join("; ")}`
    }</p>
    ${l.exclusions
      .filter((e) => e.ruleId !== "ex-monument-village-2236")
      .map(
        (e) =>
          `<div class="qrow"><div><div>${esc(EXCLUSION_TEXT[e.ruleId] ?? e.ruleId)} <span class="pill ${STATE_PILL[e.state]?.cls ?? "grey"}">${STATE_PILL[e.state]?.label ?? e.state}</span></div><div class="small muted">${esc(e.reason)}</div></div></div>`,
      )
      .join("")}
  </div>`;
}

const STAGE_TEXT: Record<string, { cls: string; label: string }> = {
  granted: { cls: "ok", label: "Granted" },
  refused: { cls: "bad", label: "Refused" },
  applied: { cls: "grey", label: "Applied" },
  notice: { cls: "grey", label: "Notice" },
  other: { cls: "grey", label: "Publication" },
};

/** Published permit applications and decisions for this home. */
function permitCard(ctx: PlotContext): string {
  const p = ctx.permits;
  if (!p) return "";
  return `<div class="card">
    <h3>Permit history</h3>
    <p class="small muted" style="margin:0 0 6px">${
      p.status === "missing"
        ? "The municipality's publications could not be searched."
        : `From the municipality's official publications (Gemeenteblad), digital since about 2010. Older permits are not in this source, so "none found" says nothing about earlier work.`
    }</p>
    ${
      p.records.length
        ? p.records
            .map(
              (r) =>
                `<div class="qrow"><div><div>${esc(r.date ?? "")} <span class="pill ${STAGE_TEXT[r.stage]?.cls ?? "grey"}">${STAGE_TEXT[r.stage]?.label ?? r.stage}</span> ${r.topics.map((t) => `<span class="pill grey">${esc(t)}</span>`).join(" ")}</div><div class="small muted">${esc(r.summary)}${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">publication</a>` : ""}</div></div></div>`,
            )
            .join("")
        : p.status === "missing"
          ? ""
          : `<p class="small" style="margin:0">No published applications or permits found for this home.</p>`
    }
  </div>`;
}

function obstacleText(ctx: PlotContext): string {
  const o = ctx.obstacles;
  if (!o) return "Unknown: the height scan could not be loaded";
  const tall = o.obstacles.filter((x) => x.kind === "tall");
  const medium = o.obstacles.filter((x) => x.kind === "medium");
  const over = o.obstacles.filter((x) => x.kind === "overhang");
  const onLine = o.obstacles.filter((x) => x.kind === "boundary");
  const structures = ctx.structures.filter((s) => s.onPlotShare > 0.3);
  const parts = [
    tall.length ? `${tall.length} tall (trees or high structures), ${o.tallM2} m²` : "",
    medium.length
      ? `${medium.length} medium (hedges, shrubs, maybe a parked car), ${o.mediumM2} m²`
      : "",
    onLine.length
      ? `${onLine.length} tree(s) on the boundary line, ${o.boundaryM2} m² over the plot`
      : "",
    over.length
      ? `branches from ${over.length} tree(s) next door hang over ${o.overhangM2} m²`
      : "",
    structures.length
      ? `registered: ${structures.map((s) => STRUCTURE_TEXT[s.type] ?? s.type).join(", ")}`
      : "",
  ].filter(Boolean);
  return `${parts.length ? esc(parts.join("; ")) : "None found above 1 m"}<div class="small muted">In ${o.yardM2} m² of open garden, from the laser height scan (a snapshot; trees change).</div>`;
}

/** Overlay names for the map's menu (kept here so the map code loads only when shown). */
const OVERLAY_LIST: [OverlayId, string][] = [
  ["plot", "Plot, house and homes on the same parcel"],
  ["buildings", "Neighbouring buildings"],
  ["parcels", "Parcel lines (cadastral map)"],
  ["public", "Streets, paths and green"],
  ["trees", "Trees and hedges"],
  ["obstacles", "Obstacles in the garden (height scan)"],
  ["access", "Car access"],
  ["edges", "Edge types"],
  ["labels", "House numbers and street names"],
];

const message3d = (title: string, body: string, reload: boolean) =>
  `<div class="card error-box" style="margin:24px"><h3 style="margin-top:0">${esc(title)}</h3><p class="muted small">${esc(body)}</p>${reload ? `<button class="btn" onclick="location.reload()">Reload the page</button>` : ""}</div>`;

function sessionStorageGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function sessionStorageSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode): we simply do not auto-reload
  }
}

const checkHref = (q: RunResult["query"]) =>
  `#/check/${encodeURIComponent(q.postcode)}/${encodeURIComponent(q.number)}${q.addition ? `/${encodeURIComponent(q.addition)}` : ""}`;

export async function renderCheck(
  root: HTMLElement,
  query: RunResult["query"],
  mode: RunResult["mode"],
  developer: boolean,
  initialView: View = "carport",
  rec?: string,
): Promise<void> {
  disposeScene();
  let result = lastRun();
  if (
    !result ||
    result.mode !== mode ||
    result.rec !== rec ||
    !sameQuery(result.query, query) ||
    !result.context
  ) {
    root.innerHTML = `<div class="loading"><div class="spinner"></div>Reading the public registers for ${esc(query.postcode)} ${esc(query.number)}${query.addition ? esc(query.addition) : ""}…</div>`;
    result = await runCheck(query, mode, rec);
  }

  if (!result.context) {
    root.innerHTML = `
      <div class="card error-box" style="max-width:640px">
        <h2>We couldn't check this address</h2>
        <p>${esc(result.error?.message ?? "Unknown error.")}</p>
        <p class="small muted">Error code ${esc(result.error?.code ?? "")}. The <a href="#/system">System view</a> shows which step stopped.</p>
        <a class="btn" href="#/">Try another address</a>
      </div>`;
    return;
  }

  const ctx = result.context;
  const layers: Pick<Layers, "aerial"> = { aerial: "Actueel_orthoHR" };
  const overlays: Record<OverlayId, boolean> = {
    plot: true,
    buildings: true,
    parcels: true,
    public: true,
    trees: true,
    obstacles: true,
    access: true,
    edges: true,
    labels: true,
  };
  const ms = ctx.measurements;
  const L = ctx.layout;
  const house = ctx.house[0];
  let selected: string | undefined = "plot:main";
  let view: View = initialView;
  let dims = true;
  const plotEdges = new Set(ctx.edges.map((e) => e.kind));
  const frontNote =
    ctx.frame.method === "street-label"
      ? `Front faces ${esc(ctx.frame.streetName ?? "the street")} (from the street-name label).`
      : ctx.frame.method === "longest-public"
        ? "Front is estimated (street name not found next to the plot)."
        : "No public side found.";

  root.innerHTML = `
    <div class="check-head">
      <div>
        <div class="muted small">${
          rec
            ? `<span class="pill warn">Recorded ${esc(rec.slice(8, 10))}-${esc(rec.slice(5, 7))}-${esc(rec.slice(0, 4))}, batch ${esc(rec.split("/")[0]?.split("-s")[1] ?? "")}</span> <a href="#/examples">all examples</a> · <a href="${checkHref(query)}">check live now</a> · `
            : mode === "demo"
              ? '<span class="pill warn">Recorded example</span> '
              : '<span class="pill ok">Live data</span> '
        }${result.totalMs} ms · <a href="#/system">see every step</a></div>
        <h1>${esc(ctx.address.label)}</h1>
      </div>
      <a class="btn" href="#/">Check another address</a>
    </div>
    <div class="layout">
      <div>
        <div class="card plan-wrap">
          <div class="tabs">
            <button data-view="carport">Carport</button>
            <button data-view="map">Map and aerial photo</button>
            <button data-view="2d">2D plan</button>
            <button data-view="3d">3D view</button>
            <button data-view="street">Street View and 3D photos</button>
          </div>
          <div id="view"></div>
          <div class="plan-tools" id="tools-map">
            <label>Aerial photo <select id="l-aerial">${AERIAL_YEARS.map(([k, l]) => `<option value="${k}"${k === layers.aerial ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
            <label><input type="checkbox" id="l-all" checked /> Overlays</label>
            <details class="overlay-menu"><summary>Choose overlays</summary><div>${OVERLAY_LIST.map(([id, label]) => `<label><input type="checkbox" data-overlay="${id}" ${overlays[id] ? "checked" : ""}/> ${esc(label)}</label>`).join("")}</div></details>
            <span style="margin-left:auto">Drag to move · scroll or pinch to zoom · click to inspect</span>
          </div>
          <div class="plan-tools" id="tools-2d">
            <label><input type="checkbox" id="l-dims" checked /> Dimensions</label>
            <span class="small">${frontNote}</span>
            <span style="margin-left:auto">Click any object to inspect it</span>
          </div>
          <div class="plan-tools" id="tools-carport"><span class="small">Every rule is checked live as you move the carport. Rules: omgevingsplan Woensdrecht and Bbl, versions shown per check.</span></div>
          <div class="plan-tools" id="tools-street"><span>Free outside viewers, opened at this house in a new tab.</span></div>
          <div class="plan-tools" id="tools-3d"><span>Drag to rotate · scroll to zoom · right-drag to move. Shapes from 3D BAG (CC BY 4.0).</span></div>
          <div class="plan-tools"><label><input type="checkbox" id="l-dev" ${developer ? "checked" : ""} /> Developer details in the Inspector</label></div>
          <div class="legend" id="legend">${legend()}</div>
        </div>

      </div>
      <aside class="side">
        <div class="card">
          <h2>This plot</h2>
          <dl class="facts">
            <dt>Plot</dt><dd>${esc(ctx.plot.id)}, ${m2(ctx.plot.areaM2)}${L.plotWidthM ? `<div class="small muted">${L.plotWidthM} m wide × ${L.plotDepthM} m deep</div>` : ""}</dd>
            <dt>House</dt><dd>${esc(HOUSE_TYPE_TEXT[ctx.houseType] ?? ctx.houseType)}${house?.bouwjaar ? `, built ${house.bouwjaar}` : ""}<div class="small muted">${ms.houseLengthM ? `${ms.houseLengthM} × ${ms.houseWidthM} m` : "Size unknown"}${ms.houseHeightM !== undefined ? `, ${ms.houseHeightM} m high` : ""}${house?.heights?.storeys ? `, ~${house.heights.storeys} storeys` : ""}</div></dd>
            ${L.setbacks ? `<dt>Yard</dt><dd>${L.setbacks.frontM} m in front, ${L.setbacks.rearM} m garden behind</dd>` : ""}
            <dt>Car access</dt><dd><span class="pill ${ACCESS_TEXT[ctx.access.level]?.cls ?? "grey"}">${esc(ACCESS_TEXT[ctx.access.level]?.label ?? ctx.access.level)}</span><div class="small muted" style="margin-top:4px">${esc(ctx.access.reason)}</div></dd>
            <dt>Other buildings</dt><dd>${ctx.outbuildings.length ? ctx.outbuildings.map((b) => esc(b.label ?? "Outbuilding")).join("; ") : "None registered"}</dd>
            <dt>Shared walls</dt><dd>${plotEdges.has("shared-wall") ? "Yes" : "None found"}</dd>
            <dt>Garden obstacles</dt><dd>${obstacleText(ctx)}</dd>
            <dt>Registered trees</dt><dd>${ctx.trees === null ? "Unknown" : ctx.trees.length ? `${ctx.trees.length} nearby` : "None nearby"}</dd>
          </dl>
        </div>
        ${legalCard(ctx)}
        ${permitCard(ctx)}
        <div class="card">
          <h3>Surroundings</h3>
          <p class="small muted" style="margin:0 0 6px">What lies along each side of the plot.</p>
          ${ctx.sides
            .map(
              (s) =>
                `<div class="qrow"><div><div>${esc(SIDE_TEXT[s.side] ?? s.side)} <span class="small muted">(${s.lengthM} m)</span></div>${s.parts
                  .map((p) => `<div class="small muted">${esc(p.label)}: ${p.lengthM} m</div>`)
                  .join("")}${
                  s.roadBeyond
                    ? `<div class="small">Road ${s.roadBeyond.acrossM} m beyond, across ${esc(s.roadBeyond.via.map((v) => VIA_TEXT[v] ?? SURFACE_TEXT[v] ?? v).join(" and "))} (${s.roadBeyond.lengthM} m of boundary)</div>`
                    : ""
                }</div></div>`,
            )
            .join("")}
        </div>
        <div class="card">
          <h3>Worth knowing</h3>
          ${
            ctx.flags.length
              ? ctx.flags
                  .map(
                    (f) =>
                      `<div class="flag"><span class="dot"></span><span>${esc(FLAG_TEXT[f.code] ?? f.detail)}</span></div>`,
                  )
                  .join("")
              : `<p class="small muted" style="margin:0">Nothing unusual found in the data for this plot.</p>`
          }
        </div>
        <div class="card">${qualityCard(ctx.quality)}</div>
        <div class="card" id="inspector"></div>
      </aside>
    </div>`;

  const viewEl = root.querySelector<HTMLElement>("#view");
  const inspEl = root.querySelector<HTMLElement>("#inspector");
  const devBox = root.querySelector<HTMLInputElement>("#l-dev");
  const tools: Record<View, HTMLElement | null> = {
    map: root.querySelector("#tools-map"),
    "2d": root.querySelector("#tools-2d"),
    "3d": root.querySelector("#tools-3d"),
    street: root.querySelector("#tools-street"),
    carport: root.querySelector("#tools-carport"),
  };
  let carportView: { dispose(): void } | undefined;
  let mountingCarport = false;
  const legendEl = root.querySelector<HTMLElement>("#legend");

  let mounting3d = false;
  let mountingMap = false;
  const drawInspector = () => {
    if (inspEl) inspEl.innerHTML = renderInspector(ctx, selected, devBox?.checked ?? false);
  };
  const draw = async () => {
    if (!viewEl) return;
    (Object.keys(tools) as View[]).forEach((v) => {
      const t = tools[v];
      if (t) t.style.display = v === view ? "" : "none";
    });
    root
      .querySelectorAll<HTMLButtonElement>(".tabs button")
      .forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    if (legendEl)
      legendEl.style.display =
        view === "3d" || view === "street" || view === "carport" ? "none" : "";
    if (view !== "carport") {
      carportView?.dispose();
      carportView = undefined;
    }
    if (view !== "3d") {
      scene?.dispose();
      scene = undefined;
    }
    if (view !== "map") disposeMap();
    if (view === "map") {
      if (mapView) mapView.setSelected(selected);
      else if (!mountingMap) {
        viewEl.className = "";
        viewEl.innerHTML = `<div class="loading" style="padding:30px"><div class="spinner"></div>Loading the map…</div>`;
        mountingMap = true;
        try {
          const { mountMap } = await import("../map.ts");
          if (view === "map") {
            mapView = mountMap(viewEl, ctx, {
              aerial: layers.aerial,
              overlays,
              ...(selected ? { selected } : {}),
              onSelect: (key) => {
                selected = key;
                drawInspector();
              },
            });
          }
        } catch (err) {
          console.error(err);
          viewEl.innerHTML = message3d(
            "The map could not be loaded",
            "The site was probably updated while this page was open.",
            true,
          );
        } finally {
          mountingMap = false;
        }
      }
    } else if (view === "carport") {
      if (!carportView && !mountingCarport) {
        viewEl.className = "";
        viewEl.innerHTML = `<div class="loading" style="padding:30px"><div class="spinner"></div>Finding the best spot for a carport…</div>`;
        mountingCarport = true;
        try {
          const { mountCarport } = await import("../carport.ts");
          if (view === "carport") carportView = await mountCarport(viewEl, ctx);
        } catch (err) {
          console.error(err);
          viewEl.innerHTML = message3d(
            "The carport check could not be loaded",
            "The site was probably updated while this page was open.",
            true,
          );
        } finally {
          mountingCarport = false;
        }
      }
    } else if (view === "street") {
      viewEl.className = "";
      viewEl.innerHTML = lookAround(ctx);
    } else if (view === "2d") {
      viewEl.className = "";
      viewEl.innerHTML = drawWorkspacePlan(ctx, selected, dims);
    } else if (!scene && !mounting3d) {
      viewEl.className = "view3d";
      viewEl.innerHTML = `<div class="loading" style="padding:30px"><div class="spinner"></div>Building the 3D model…</div>`;
      mounting3d = true;
      try {
        scene = await open3d(viewEl, ctx, () => view === "3d");
      } finally {
        mounting3d = false;
      }
    }
    drawInspector();
  };

  root.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      view = (b.dataset.view as View) ?? "map";
      rememberView(view);
      void draw();
    }),
  );
  viewEl?.addEventListener("click", (e) => {
    if (view !== "2d") return; // the map handles its own clicks; 3D has none
    selected = (e.target as Element).closest("[data-sel]")?.getAttribute("data-sel") ?? undefined;
    void draw();
  });
  if (inspEl) bindAnswers(inspEl, () => void draw());
  root.querySelector<HTMLSelectElement>("#l-aerial")?.addEventListener("change", (e) => {
    layers.aerial = (e.target as HTMLSelectElement).value;
    mapView?.setAerial(layers.aerial);
  });
  const overlayBoxes = [...root.querySelectorAll<HTMLInputElement>("input[data-overlay]")];
  const allBox = root.querySelector<HTMLInputElement>("#l-all");
  const syncAll = () => {
    if (!allBox) return;
    const on = overlayBoxes.filter((b) => b.checked).length;
    allBox.checked = on > 0;
    allBox.indeterminate = on > 0 && on < overlayBoxes.length;
  };
  overlayBoxes.forEach((box) =>
    box.addEventListener("change", () => {
      const id = box.dataset.overlay as OverlayId;
      overlays[id] = box.checked;
      mapView?.setOverlay(id, box.checked);
      syncAll();
    }),
  );
  allBox?.addEventListener("change", () => {
    for (const box of overlayBoxes) {
      box.checked = allBox.checked;
      const id = box.dataset.overlay as OverlayId;
      overlays[id] = box.checked;
      mapView?.setOverlay(id, box.checked);
    }
    allBox.indeterminate = false;
  });
  root.querySelector<HTMLInputElement>("#l-dims")?.addEventListener("change", (e) => {
    dims = (e.target as HTMLInputElement).checked;
    void draw();
  });
  devBox?.addEventListener("change", drawInspector);
  await draw();
}
