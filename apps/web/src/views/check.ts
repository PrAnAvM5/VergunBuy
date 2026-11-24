import { esc, FLAG_TEXT, HOUSE_TYPE_TEXT, m2 } from "../format.ts";
import { renderInspector } from "../inspector.ts";
import { drawPlan, legend, type Layers } from "../plan.ts";
import { runCheck, type RunResult } from "../run.ts";

export async function renderCheck(
  root: HTMLElement,
  query: RunResult["query"],
  mode: RunResult["mode"],
  developer: boolean,
): Promise<void> {
  root.innerHTML = `<div class="loading"><div class="spinner"></div>Reading the public registers for ${esc(query.postcode)} ${esc(query.number)}${query.addition ? esc(query.addition) : ""}…</div>`;
  const result = await runCheck(query, mode);

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
  const layers: Layers = { context: true, edges: true };
  let selected: string | undefined;
  const plotEdges = new Set(ctx.edges.map((e) => e.kind));
  const publicLen = ctx.edges.filter((e) => e.kind === "public").reduce((s, e) => s + e.lengthM, 0);

  root.innerHTML = `
    <div class="check-head">
      <div>
        <div class="muted small">${mode === "demo" ? '<span class="pill warn">Recorded example (24-11-2026)</span> ' : '<span class="pill ok">Live data</span> '}${result.totalMs} ms · <a href="#/system">see every step</a></div>
        <h1>${esc(ctx.address.label)}</h1>
      </div>
      <a class="btn" href="#/">Check another address</a>
    </div>
    <div class="layout">
      <div>
        <div class="card plan-wrap">
          <div id="plan"></div>
          <div class="plan-tools">
            <label><input type="checkbox" id="l-edges" checked /> Edge types</label>
            <label><input type="checkbox" id="l-context" checked /> Surroundings</label>
            <label><input type="checkbox" id="l-dev" ${developer ? "checked" : ""} /> Developer details</label>
            <span style="margin-left:auto">Click any object to inspect it</span>
          </div>
          <div class="legend">${legend()}</div>
        </div>
        <div class="card coming" style="margin-top:14px">
          <h3>Next: carport positions</h3>
          <p class="small muted" style="margin:0">The plan and plot edges above are the foundation. The next build step places single and double carports on this real plot and checks each position against the Woensdrecht rules, as in the prototype.</p>
        </div>
      </div>
      <aside class="side">
        <div class="card">
          <h2>This plot</h2>
          <dl class="facts">
            <dt>Plot</dt><dd>${esc(ctx.plot.id)}, ${m2(ctx.plot.areaM2)}</dd>
            <dt>House</dt><dd>${esc(HOUSE_TYPE_TEXT[ctx.houseType] ?? ctx.houseType)}${ctx.house[0]?.bouwjaar ? `, built ${ctx.house[0].bouwjaar}` : ""}</dd>
            <dt>Street side</dt><dd>${publicLen > 0 ? `${publicLen.toFixed(1)} m of boundary on public area` : "None found"}</dd>
            <dt>Shared walls</dt><dd>${plotEdges.has("shared-wall") ? "Yes" : "None found"}</dd>
          </dl>
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
        <div class="card" id="inspector"></div>
      </aside>
    </div>`;

  const planEl = root.querySelector<HTMLElement>("#plan");
  const inspEl = root.querySelector<HTMLElement>("#inspector");
  const devBox = root.querySelector<HTMLInputElement>("#l-dev");
  const redraw = () => {
    if (planEl) planEl.innerHTML = drawPlan(ctx, layers, selected);
    if (inspEl) inspEl.innerHTML = renderInspector(ctx, selected, devBox?.checked ?? false);
  };
  planEl?.addEventListener("click", (e) => {
    const target = (e.target as Element).closest("[data-sel]");
    selected = target?.getAttribute("data-sel") ?? undefined;
    redraw();
  });
  root.querySelector<HTMLInputElement>("#l-edges")?.addEventListener("change", (e) => {
    layers.edges = (e.target as HTMLInputElement).checked;
    redraw();
  });
  root.querySelector<HTMLInputElement>("#l-context")?.addEventListener("change", (e) => {
    layers.context = (e.target as HTMLInputElement).checked;
    redraw();
  });
  devBox?.addEventListener("change", redraw);
  selected = "plot:main";
  redraw();
}
