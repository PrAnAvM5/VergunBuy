/**
 * Examples: every home from the validation runs, grouped by batch. Each opens the check page
 * replayed from its recording (same data as the report), next to its aerial check image.
 */
import { ACCESS_TEXT, esc, FLAG_TEXT } from "../format.ts";

interface Home {
  label: string;
  village: string;
  access: string | null;
  route: string | null;
  flags: string[];
  houseType: string | null;
  error: string | null;
  /** Result when the batch was recorded, before later fixes. */
  recorded?: { access: string | null; route: string | null };
  postcode?: string;
  number?: string;
  addition?: string;
  rec?: string;
  image?: string;
}
interface Run {
  id: string;
  date: string;
  seed: number;
  homes: Home[];
}

/** Flags worth seeing in a list; the rest are on the check page. */
const KEY_FLAGS: Record<string, string> = {
  SHARED_PLOT: "Shared parcel",
  BUILDING_ON_BOUNDARY: "Building on boundary",
  PLOT_AREA_MISMATCH: "Plot area mismatch",
  FRONT_ESTIMATED: "Front estimated",
  PUBLIC_AREA_UNKNOWN: "Street data missing",
  POSSIBLE_ACHTERPAD: "Possible rear path",
  WATER_NEARBY: "Water",
  HEIGHTS_PARTIAL: "Heights partial",
  INVALID_GEOMETRY: "Unclean shape",
};

const ROUTE_TEXT: Record<string, string> = {
  direct: "road along the plot",
  "across-pavement": "road beyond pavement",
};

let filter = { village: "", access: "" };

export async function renderExamples(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="loading"><div class="spinner"></div>Loading the examples…</div>`;
  let runs: Run[];
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}validation/index.json`);
    if (!res.ok) throw new Error(String(res.status));
    runs = ((await res.json()) as { runs: Run[] }).runs;
  } catch {
    root.innerHTML = `<div class="card error-box" style="max-width:640px"><h2>The examples could not be loaded</h2><p class="muted">Try reloading the page.</p></div>`;
    return;
  }
  const villages = [...new Set(runs.flatMap((r) => r.homes.map((h) => h.village)))].sort();
  const total = runs.reduce((n, r) => n + r.homes.length, 0);

  const row = (h: Home) => {
    const href = h.rec
      ? `#/check/${encodeURIComponent(h.postcode ?? "")}/${encodeURIComponent(h.number ?? "")}${h.addition ? `/${encodeURIComponent(h.addition)}` : ""}?rec=${encodeURIComponent(h.rec)}`
      : undefined;
    const access = h.access ? ACCESS_TEXT[h.access] : undefined;
    const flags = h.flags
      .filter((f) => KEY_FLAGS[f])
      .map(
        (f) =>
          `<span class="pill grey" title="${esc(FLAG_TEXT[f] ?? f)}">${esc(KEY_FLAGS[f])}</span>`,
      )
      .join(" ");
    const photo = h.image
      ? `<a href="${import.meta.env.BASE_URL}validation/${esc(h.image)}" target="_blank" rel="noopener"><img class="ex-thumb" loading="lazy" alt="Aerial check image of ${esc(h.label)}" src="${import.meta.env.BASE_URL}validation/${esc(h.image)}"/></a>`
      : "";
    return `<tr>
      <td class="ex-photo">${photo}</td>
      <td>${href ? `<a href="${href}"><strong>${esc(h.label)}</strong></a>` : `<strong>${esc(h.label)}</strong>`}<div class="small muted">${esc(h.village)}${h.houseType ? ` · ${esc(h.houseType)}` : ""}</div></td>
      <td>${
        h.error
          ? `<span class="pill bad">Error</span><div class="small muted">${esc(h.error)}</div>`
          : `<span class="pill ${access?.cls ?? "grey"}">${esc(access?.label ?? h.access ?? "")}</span>${h.route ? `<div class="small muted">${esc(ROUTE_TEXT[h.route] ?? h.route)}</div>` : ""}${
              h.recorded &&
              (h.recorded.access !== h.access || (h.recorded.route ?? null) !== (h.route ?? null))
                ? `<div class="small muted">at recording: ${esc(ACCESS_TEXT[h.recorded.access ?? ""]?.label ?? h.recorded.access ?? "?")}${h.recorded.route ? `, ${esc(ROUTE_TEXT[h.recorded.route] ?? h.recorded.route)}` : ""}</div>`
                : ""
            }`
      }</td>
      <td>${flags}</td>
    </tr>`;
  };

  const draw = () => {
    const list = root.querySelector<HTMLElement>("#ex-list");
    if (!list) return;
    list.innerHTML = runs
      .map((r, i) => {
        const homes = r.homes.filter(
          (h) =>
            (!filter.village || h.village === filter.village) &&
            (!filter.access ||
              (filter.access === "error" ? !!h.error : h.access === filter.access)),
        );
        if (!homes.length) return "";
        return `<div class="card" style="margin-bottom:16px">
          <h3 style="margin-top:0">Batch ${runs.length - i} <span class="small muted">recorded ${esc(r.date)} · ${r.homes.length} homes · seed ${esc(r.seed)}</span></h3>
          <table class="src ex-table"><thead><tr><th>Aerial</th><th>Address</th><th>Car access</th><th>Worth knowing</th></tr></thead>
          <tbody>${homes.map(row).join("")}</tbody></table>
        </div>`;
      })
      .join("");
  };

  root.innerHTML = `
    <div class="check-head">
      <div>
        <h1>Examples</h1>
        <p class="muted" style="max-width:760px">${total} randomly drawn homes from the validation runs, spread over the five villages. Each one is replayed from the data recorded that day through today's version of the checks, so it opens instantly, with the 3D view and every step; where a later fix changed the result, the result at recording time is shown too. The aerial image shows the plot (white), house (purple), registered driveway crossings (yellow) and where a car can reach the boundary (orange).</p>
      </div>
    </div>
    <div class="plan-tools" style="margin-bottom:12px">
      <label>Village <select id="ex-village"><option value="">All</option>${villages.map((v) => `<option${v === filter.village ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
      <label>Car access <select id="ex-access"><option value="">All</option>${Object.entries(
        ACCESS_TEXT,
      )
        .map(
          ([k, v]) =>
            `<option value="${esc(k)}"${k === filter.access ? " selected" : ""}>${esc(v.label)}</option>`,
        )
        .join(
          "",
        )}<option value="error"${filter.access === "error" ? " selected" : ""}>Error</option></select></label>
    </div>
    <div id="ex-list"></div>`;
  root.querySelector<HTMLSelectElement>("#ex-village")?.addEventListener("change", (e) => {
    filter = { ...filter, village: (e.target as HTMLSelectElement).value };
    draw();
  });
  root.querySelector<HTMLSelectElement>("#ex-access")?.addEventListener("change", (e) => {
    filter = { ...filter, access: (e.target as HTMLSelectElement).value };
    draw();
  });
  draw();
}
