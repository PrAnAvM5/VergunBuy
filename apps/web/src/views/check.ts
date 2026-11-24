/**
 * The address page: everything about one plot on one screen.
 * Main panel with three views of the same data (Map with aerial photo, 2D plan with the street
 * at the bottom, 3D model), and side cards: summary, surroundings per side, warnings, data
 * completeness and the Inspector. A click in the Map or 2D plan opens the object in the Inspector.
 */
import { ACCESS_TEXT, esc, FLAG_TEXT, HOUSE_TYPE_TEXT, m2, qualityCard } from "../format.ts";
import { bindAnswers, renderInspector } from "../inspector.ts";
import { AERIAL_YEARS, drawPlan, legend, type Layers } from "../plan.ts";
import { drawWorkspacePlan } from "../plan2d.ts";
import { lastRun, runCheck, type RunResult } from "../run.ts";
import type { SceneHandle } from "../scene3d.ts";

export type View = "map" | "2d" | "3d";

let scene: SceneHandle | undefined;
export const disposeScene = () => {
  scene?.dispose();
  scene = undefined;
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

export async function renderCheck(
  root: HTMLElement,
  query: RunResult["query"],
  mode: RunResult["mode"],
  developer: boolean,
  initialView: View = "map",
): Promise<void> {
  disposeScene();
  let result = lastRun();
  if (!result || result.mode !== mode || !sameQuery(result.query, query) || !result.context) {
    root.innerHTML = `<div class="loading"><div class="spinner"></div>Reading the public registers for ${esc(query.postcode)} ${esc(query.number)}${query.addition ? esc(query.addition) : ""}…</div>`;
    result = await runCheck(query, mode);
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
  const layers: Layers = {
    context: true,
    edges: true,
    dimensions: false,
    aerial: "Actueel_orthoHR",
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
        <div class="muted small">${mode === "demo" ? '<span class="pill warn">Recorded example</span> ' : '<span class="pill ok">Live data</span> '}${result.totalMs} ms · <a href="#/system">see every step</a></div>
        <h1>${esc(ctx.address.label)}</h1>
      </div>
      <a class="btn" href="#/">Check another address</a>
    </div>
    <div class="layout">
      <div>
        <div class="card plan-wrap">
          <div class="tabs">
            <button data-view="map">Map and aerial photo</button>
            <button data-view="2d">2D plan</button>
            <button data-view="3d">3D view</button>
          </div>
          <div id="view"></div>
          <div class="plan-tools" id="tools-map">
            <label>Aerial photo <select id="l-aerial">${AERIAL_YEARS.map(([k, l]) => `<option value="${k}"${k === layers.aerial ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
            <label><input type="checkbox" id="l-edges" checked /> Edge types</label>
            <label><input type="checkbox" id="l-context" checked /> Surroundings</label>
            <span style="margin-left:auto">Click any object to inspect it</span>
          </div>
          <div class="plan-tools" id="tools-2d">
            <label><input type="checkbox" id="l-dims" checked /> Dimensions</label>
            <span class="small">${frontNote}</span>
            <span style="margin-left:auto">Click any object to inspect it</span>
          </div>
          <div class="plan-tools" id="tools-3d"><span>Drag to rotate · scroll to zoom · right-drag to move. Shapes from 3D BAG (CC BY 4.0).</span></div>
          <div class="plan-tools"><label><input type="checkbox" id="l-dev" ${developer ? "checked" : ""} /> Developer details in the Inspector</label></div>
          <div class="legend" id="legend">${legend()}</div>
        </div>
        <div class="card coming" style="margin-top:14px">
          <h3>Next: carport positions</h3>
          <p class="small muted" style="margin:0">The carport will be placed and dragged in the 2D plan and 3D view, with every rule checked live, as in the prototype, now on the real plot.</p>
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
            <dt>Registered trees</dt><dd>${ctx.trees === null ? "Unknown" : ctx.trees.length ? `${ctx.trees.length} nearby` : "None nearby"}</dd>
          </dl>
        </div>
        <div class="card">
          <h3>Surroundings</h3>
          <p class="small muted" style="margin:0 0 6px">What lies along each side of the plot.</p>
          ${ctx.sides
            .map(
              (s) =>
                `<div class="qrow"><div><div>${esc(SIDE_TEXT[s.side] ?? s.side)} <span class="small muted">(${s.lengthM} m)</span></div>${s.parts
                  .map((p) => `<div class="small muted">${esc(p.label)}: ${p.lengthM} m</div>`)
                  .join("")}</div></div>`,
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
  };
  const legendEl = root.querySelector<HTMLElement>("#legend");

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
    if (legendEl) legendEl.style.display = view === "3d" ? "none" : "";
    if (view !== "3d") disposeScene();
    if (view === "map") {
      viewEl.className = "";
      viewEl.innerHTML = drawPlan(ctx, layers, selected);
    } else if (view === "2d") {
      viewEl.className = "";
      viewEl.innerHTML = drawWorkspacePlan(ctx, selected, dims);
    } else if (!scene) {
      viewEl.className = "view3d";
      viewEl.innerHTML = `<div class="loading" style="padding:30px"><div class="spinner"></div>Building the 3D model…</div>`;
      const { mountScene } = await import("../scene3d.ts");
      if (view !== "3d") return;
      viewEl.innerHTML = "";
      scene = mountScene(viewEl, ctx);
    }
    drawInspector();
  };

  root.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      view = (b.dataset.view as View) ?? "map";
      void draw();
    }),
  );
  viewEl?.addEventListener("click", (e) => {
    if (view === "3d") return;
    selected = (e.target as Element).closest("[data-sel]")?.getAttribute("data-sel") ?? undefined;
    void draw();
  });
  if (inspEl) bindAnswers(inspEl, () => void draw());
  root.querySelector<HTMLSelectElement>("#l-aerial")?.addEventListener("change", (e) => {
    layers.aerial = (e.target as HTMLSelectElement).value;
    void draw();
  });
  root.querySelector<HTMLInputElement>("#l-edges")?.addEventListener("change", (e) => {
    layers.edges = (e.target as HTMLInputElement).checked;
    void draw();
  });
  root.querySelector<HTMLInputElement>("#l-context")?.addEventListener("change", (e) => {
    layers.context = (e.target as HTMLInputElement).checked;
    void draw();
  });
  root.querySelector<HTMLInputElement>("#l-dims")?.addEventListener("change", (e) => {
    dims = (e.target as HTMLInputElement).checked;
    void draw();
  });
  devBox?.addEventListener("change", drawInspector);
  await draw();
}
