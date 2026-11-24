/**
 * Plot workspace (layer 2): the plot on its own, street at the bottom, as a clean 2D plan
 * with dimensions and as a 3D model built from registry data. The carport engine plugs in here next.
 */
import { esc, m2 } from "../format.ts";
import { bindAnswers, renderInspector } from "../inspector.ts";
import { drawWorkspacePlan } from "../plan2d.ts";
import { lastRun, runCheck, type RunResult } from "../run.ts";
import type { SceneHandle } from "../scene3d.ts";

let scene: SceneHandle | undefined;
export const disposeWorkspace = () => {
  scene?.dispose();
  scene = undefined;
};

const sameQuery = (a: RunResult["query"], b: RunResult["query"]) =>
  a.postcode.replace(/\s/g, "").toUpperCase() === b.postcode.replace(/\s/g, "").toUpperCase() &&
  String(a.number) === String(b.number) &&
  (a.addition ?? "") === (b.addition ?? "");

export async function renderWorkspace(
  root: HTMLElement,
  query: RunResult["query"],
  mode: RunResult["mode"],
  developer: boolean,
): Promise<void> {
  disposeWorkspace();
  let run = lastRun();
  if (!run || run.mode !== mode || !sameQuery(run.query, query) || !run.context) {
    root.innerHTML = `<div class="loading"><div class="spinner"></div>Reading the public registers…</div>`;
    run = await runCheck(query, mode);
  }
  const ctx = run.context;
  if (!ctx) {
    root.innerHTML = `<div class="card error-box" style="max-width:640px"><h2>We couldn't load this plot</h2><p>${esc(run.error?.message ?? "")}</p><a class="btn" href="#/">Try another address</a></div>`;
    return;
  }
  const L = ctx.layout;
  const s = L.setbacks;
  const house = ctx.house[0];
  const overviewHref = `#/check/${encodeURIComponent(query.postcode)}/${encodeURIComponent(query.number)}${query.addition ? `/${encodeURIComponent(query.addition)}` : ""}${mode === "demo" ? "?demo" : ""}`;
  const frontNote =
    ctx.frame.method === "street-label"
      ? `The front faces ${esc(ctx.frame.streetName ?? "the street")} (found from the street-name label in the map register).`
      : ctx.frame.method === "longest-public"
        ? "The front is estimated as the longest public side; the street name was not found nearby. On corner or rural plots this can be the wrong side."
        : "No public side found, so the plan is shown north up.";

  let tab: "2d" | "3d" = "2d";
  let selected: string | undefined = "plot:main";

  root.innerHTML = `
    <div class="check-head">
      <div>
        <div class="muted small"><a href="${overviewHref}">← Overview</a> · ${mode === "demo" ? '<span class="pill warn">Recorded example</span>' : '<span class="pill ok">Live data</span>'}</div>
        <h1>${esc(ctx.address.label)}</h1>
      </div>
    </div>
    <div class="layout">
      <div>
        <div class="card plan-wrap">
          <div class="tabs"><button data-tab="2d" class="on">2D plan</button><button data-tab="3d">3D view</button></div>
          <div id="ws-view"></div>
          <div class="plan-tools" id="ws-tools">
            <label><input type="checkbox" id="ws-dims" checked /> Dimensions</label>
            <label><input type="checkbox" id="ws-dev" ${developer ? "checked" : ""} /> Developer details</label>
            <span style="margin-left:auto">Click any object to inspect it</span>
          </div>
        </div>
        <div class="card coming" style="margin-top:14px">
          <h3>Next: place a carport</h3>
          <p class="small muted" style="margin:0">This workspace is where the carport will be placed and dragged, with every rule checked live, as in the prototype, now on the real plot.</p>
        </div>
      </div>
      <aside class="side">
        <div class="card">
          <h2>Dimensions</h2>
          <dl class="facts">
            <dt>Plot</dt><dd>${L.plotWidthM} m wide × ${L.plotDepthM} m deep (${m2(ctx.plot.areaM2)})</dd>
            ${L.houseWidthM ? `<dt>House</dt><dd>${L.houseWidthM} m wide × ${L.houseDepthM} m deep${house?.heights?.heightM !== undefined ? `, ${house.heights.heightM} m high` : ""}</dd>` : ""}
            ${s ? `<dt>Front yard</dt><dd>${s.frontM} m (house to front boundary)</dd><dt>Back garden</dt><dd>${s.rearM} m (house to rear boundary)</dd><dt>Sides</dt><dd>${s.leftM} m left, ${s.rightM} m right</dd>` : ""}
          </dl>
          <p class="small muted" style="margin:10px 0 0">${frontNote} Measured along the plot's main directions; on irregular plots these are approximations.</p>
        </div>
        <div class="card" id="ws-inspector"></div>
      </aside>
    </div>`;

  const view = root.querySelector<HTMLElement>("#ws-view");
  const insp = root.querySelector<HTMLElement>("#ws-inspector");
  const dims = root.querySelector<HTMLInputElement>("#ws-dims");
  const dev = root.querySelector<HTMLInputElement>("#ws-dev");
  const tools = root.querySelector<HTMLElement>("#ws-tools");

  const drawInspector = () => {
    if (insp) insp.innerHTML = renderInspector(ctx, selected, dev?.checked ?? false);
  };
  const draw = async () => {
    if (!view) return;
    if (tab === "2d") {
      disposeWorkspace();
      view.className = "";
      view.innerHTML = drawWorkspacePlan(ctx, selected, dims?.checked ?? true);
      if (tools) tools.style.display = "";
    } else if (!scene) {
      view.className = "view3d";
      view.innerHTML = `<div class="loading" style="padding:30px"><div class="spinner"></div>Building the 3D model…</div>`;
      const { mountScene } = await import("../scene3d.ts");
      view.innerHTML = "";
      scene = mountScene(view, ctx);
      view.insertAdjacentHTML(
        "beforeend",
        `<div class="hint">Drag to rotate · scroll to zoom · right-drag to move. Shapes from 3D BAG (CC BY 4.0).</div>`,
      );
      if (tools) tools.style.display = "none";
    }
    drawInspector();
  };
  root.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      tab = b.dataset.tab === "3d" ? "3d" : "2d";
      root.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
      void draw();
    }),
  );
  view?.addEventListener("click", (e) => {
    if (tab !== "2d") return;
    selected = (e.target as Element).closest("[data-sel]")?.getAttribute("data-sel") ?? undefined;
    void draw();
  });
  dims?.addEventListener("change", () => void draw());
  dev?.addEventListener("change", drawInspector);
  if (insp) bindAnswers(insp, drawInspector);
  await draw();
}
