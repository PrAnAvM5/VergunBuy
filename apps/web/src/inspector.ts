/**
 * Inspector (ADR-023): shows what we know about one clicked object, how sure we are,
 * where it comes from and how it was derived. The developer layer adds the raw record.
 */
import { STRUCTURE_TEXT, type PlotContext } from "@vergunbuy/data";
import { area } from "@vergunbuy/engine";
import { EDGE_TEXT, esc, isOtherHomeOnParcel, m, m2 } from "./format.ts";

interface Row {
  label: string;
  value: string;
  certainty?: "measured" | "derived" | "assumed" | "user-answered" | "unknown";
}

interface View {
  title: string;
  rows: Row[];
  source: string;
  how: string;
  raw: unknown;
}

/** User answers for facts the registers lack (ADR-020: few, optional, always with "don't know"). */
const answers = new Map<string, string>();
export const answerKey = (ctx: PlotContext, buildingId: string) =>
  `${ctx.address.bagVerblijfsobjectId}:${buildingId}`;
export const setAnswer = (key: string, value: string) =>
  value ? answers.set(key, value) : answers.delete(key);
export const getAnswer = (key: string) => answers.get(key);
export const OUTBUILDING_KINDS = ["Shed", "Garage", "Carport", "Garden room", "Other"];

const ROOF_TEXT: Record<string, string> = {
  slanted: "Sloped",
  horizontal: "Flat",
  "multiple horizontal": "Flat, at several heights",
  "could not be detected": "Not detected",
};

const certPill = (c?: Row["certainty"]) =>
  c
    ? ` <span class="pill ${c === "measured" ? "ok" : c === "derived" ? "" : c === "assumed" ? "warn" : c === "user-answered" ? "grey" : "bad"} cert">${c}</span>`
    : "";

function describe(ctx: PlotContext, key: string): View | undefined {
  const [type, ...rest] = key.split(":");
  const id = rest.join(":");
  if (type === "plot") {
    const diff = ctx.plot.registeredAreaM2
      ? ctx.plot.areaM2 - ctx.plot.registeredAreaM2
      : undefined;
    return {
      title: `Plot ${ctx.plot.id}`,
      rows: [
        { label: "Drawn area", value: m2(ctx.plot.areaM2), certainty: "measured" },
        ...(ctx.plot.registeredAreaM2
          ? [
              {
                label: "Registered area",
                value: `${m2(ctx.plot.registeredAreaM2)}${diff ? ` (drawn differs by ${m2(Math.abs(diff))})` : " (matches)"}`,
                certainty: "measured" as const,
              },
            ]
          : []),
        { label: "Boundary edges", value: `${ctx.edges.length} runs`, certainty: "derived" },
      ],
      source: "BRK Kadastrale kaart (Kadaster), CC BY 4.0",
      how: "The valid parcel that contains the address point. Cadastral map boundaries are indicative, not surveyed legal boundaries.",
      raw: ctx.plot,
    };
  }
  if (type === "house" || type === "outbuilding" || type === "neighbour") {
    const list =
      type === "house" ? ctx.house : type === "outbuilding" ? ctx.outbuildings : ctx.neighbours;
    const b = list.find((x) => x.id === id);
    if (!b) return undefined;
    const h = b.heights;
    const changed = h?.changedBetweenScans;
    const scanChange = changed?.ahn3ToAhn4
      ? "Changed between the 2014–2019 and 2020–2022 height scans"
      : changed?.ahn4ToAhn5
        ? "Changed between the 2020–2022 and 2023–2025 height scans"
        : changed && (changed.ahn3ToAhn4 === false || changed.ahn4ToAhn5 === false)
          ? "No change seen between height scans"
          : undefined;
    const rows: Row[] = [];
    const answered = type === "outbuilding" ? getAnswer(answerKey(ctx, b.id)) : undefined;
    if (answered)
      rows.push({
        label: "What it is",
        value: `${esc(answered)} (you said)`,
        certainty: "user-answered",
      });
    else if (type === "outbuilding")
      rows.push({
        label: "What it probably is",
        value: esc(b.label ?? "Outbuilding"),
        certainty: "assumed",
      });
    rows.push({
      label: "Size",
      value: `${b.lengthM ?? "?"} × ${b.widthM ?? "?"} m (${m2(area(b.outline))})`,
      certainty: "derived",
    });
    if (h?.heightM !== undefined)
      rows.push({
        label: "Height",
        value: `${h.heightM} m${h.lowestRoofM !== undefined ? ` (lowest roof ${h.lowestRoofM} m)` : ""}`,
        certainty: "measured",
      });
    if (type !== "neighbour" && h?.roofParts && h.roofParts.length > 1) {
      const top = Math.max(...h.roofParts.map((r) => r.topM));
      const low = h.roofParts.filter((r) => r.topM < top - 1.5);
      rows.push({
        label: "Roof parts",
        value: `${h.roofParts.length} roof planes${low.length ? `; ${low.length} lower part${low.length > 1 ? "s" : ""} (up to ${Math.max(...low.map((r) => r.topM))} m), often an extension or annex` : ""}`,
        certainty: "measured",
      });
    }
    if (h?.mesh)
      rows.push({
        label: "3D shape",
        value:
          h.mesh.lod === "2.2"
            ? "Real roof shape (LoD 2.2)"
            : `Simplified block (LoD ${esc(h.mesh.lod)})`,
        certainty: "measured",
      });
    if (h?.roofType)
      rows.push({
        label: "Roof",
        value: esc(ROOF_TEXT[h.roofType] ?? h.roofType),
        certainty: "measured",
      });
    if (h?.storeys !== undefined)
      rows.push({ label: "Storeys (estimated)", value: String(h.storeys), certainty: "derived" });
    if (b.bouwjaar) rows.push({ label: "Built", value: String(b.bouwjaar), certainty: "measured" });
    if (b.addresses !== undefined)
      rows.push({ label: "Addresses inside", value: String(b.addresses), certainty: "measured" });
    if (type !== "neighbour" && scanChange)
      rows.push({ label: "Height scans", value: esc(scanChange), certainty: "measured" });
    if (type !== "neighbour" && h?.registerVersion !== undefined)
      rows.push({
        label: "Register record",
        value:
          h.registerVersion > 1
            ? `Changed since creation (version ${h.registerVersion})`
            : "Unchanged since it was created (version 1)",
        certainty: "measured",
      });
    if (h?.scanYear)
      rows.push({
        label: "Measured in",
        value: `${h.scanYear} (${esc(h.scanSource ?? "AHN")})`,
        certainty: "measured",
      });
    if (b.addressLabels?.length)
      rows.push({
        label: "House numbers",
        value: esc(b.addressLabels.join(", ")),
        certainty: "measured",
      });
    if ((b.addresses ?? 0) > 0)
      rows.push({
        label: "Addresses in building",
        value: `${b.addresses}${b.use ? ` (${esc(b.use.replace(/,/g, ", "))})` : ""}`,
        certainty: "measured",
      });
    rows.push({ label: "BAG id", value: esc(b.id), certainty: "measured" });
    const otherHome = type === "neighbour" && isOtherHomeOnParcel(b);
    return {
      title:
        type === "house"
          ? "House"
          : type === "outbuilding"
            ? "Other building on this plot"
            : otherHome
              ? "Other home on the same parcel"
              : "Neighbouring building",
      rows,
      source: `BAG (outline, year, addresses; public domain)${h ? " and 3D BAG (heights, roof, scan changes; CC BY 4.0)" : ""}`,
      how:
        type === "house"
          ? "The building linked to this address in the register. Heights come from the national laser scan; a change between scans can mean an extension."
          : type === "outbuilding"
            ? "The register does not say what an outbuilding is. We describe it from its size, height and whether it has an address, so treat the description as a likely guess."
            : otherHome
              ? "Most of this building lies on the same cadastral parcel as this address, and it holds homes. The cadastral map shows one parcel; who owns which part (for example through apartment rights) is not in the open data."
              : "A registered building near the plot, used to detect shared walls.",
      raw: b,
    };
  }
  if (type === "obstacle") {
    const o = ctx.obstacles?.obstacles.find((x) => x.id === id);
    if (!o) return undefined;
    return {
      title: o.kind === "tall" ? "Tall obstacle (tree or high structure)" : "Medium obstacle",
      rows: [
        { label: "Area", value: m2(o.areaM2), certainty: "measured" },
        { label: "Highest point", value: `${o.maxHeightM} m above ground`, certainty: "measured" },
        {
          label: "Likely",
          value:
            o.kind === "tall"
              ? "A tree or a high garden structure: treat as fixed"
              : "A hedge, shrub or low structure, or something movable (a parked car, a trailer) that stood there during the scan",
          certainty: "assumed",
        },
      ],
      source: "AHN (national laser height scan, 0.5 m), via PDOK, CC0",
      how: "Surface height minus ground height, inside the plot and outside registered buildings. Cells of 0.5 × 0.5 m above 1 m that touch form one obstacle; it is tall when at least 1 m² reaches 2.5 m. The scan is a snapshot of one date, so check the aerial photo or Street View for what is there now.",
      raw: { ...o, cells: `${o.cells.length} cells`, cellHeights: undefined },
    };
  }
  if (type === "structure") {
    const s = ctx.structures.find((x) => x.id === id);
    if (!s) return undefined;
    return {
      title: STRUCTURE_TEXT[s.type] ?? s.type,
      rows: [
        { label: "Area", value: m2(area(s.outline)), certainty: "measured" },
        {
          label: "On this plot",
          value: `${Math.round(s.onPlotShare * 100)}%`,
          certainty: "measured",
        },
      ],
      source: "BGT (overig bouwwerk), CC0",
      how: "Registered by the municipality as a structure that is not a building, such as a roof without walls (often a carport) or a pool. Its size and position are as drawn on the map.",
      raw: s,
    };
  }
  if (type === "tree") {
    const t = ctx.trees?.find((x) => x.id === id);
    if (!t) return undefined;
    return {
      title: "Registered tree",
      rows: [
        { label: "Crown shown", value: `${t.crownM} m wide`, certainty: "assumed" },
        ...(t.registeredAt
          ? [{ label: "Registered", value: esc(t.registeredAt), certainty: "measured" as const }]
          : []),
      ],
      source: "BGT (vegetatieobject), CC0",
      how: "The municipality registers street trees as points, without size, so the crown circle is an assumption. Trees in gardens are not registered anywhere; use the aerial photo to spot them. Whether a tree is protected is checked separately.",
      raw: t,
    };
  }
  if (type === "exit") {
    const e = ctx.exits.find((x) => x.id === id);
    if (!e) return undefined;
    return {
      title: "Driveway crossing (existing exit)",
      rows: [
        {
          label: "Along the plot",
          value: e.alongPlotM > 0 ? m(e.alongPlotM) : "Touches the plot corner",
          certainty: "derived",
        },
        ...(e.registeredAt
          ? [{ label: "Registered", value: esc(e.registeredAt), certainty: "measured" as const }]
          : []),
      ],
      source: "BGT (wegdeel, function 'inrit'), CC0",
      how: "A registered crossing from the road onto a plot. A carport that uses an existing exit avoids the separate permit needed for a new one.",
      raw: e,
    };
  }
  if (type === "hedge") {
    return {
      title: "Hedge",
      rows: [],
      source: "BGT (vegetatieobject), CC0",
      how: "A hedge registered by the municipality. Garden hedges are usually not registered.",
      raw: id,
    };
  }
  if (type === "public") {
    const a = ctx.publicAreas?.find((x) => x.id === id);
    if (!a) return undefined;
    return {
      title: "Public area",
      rows: [
        { label: "Kind", value: esc(a.kind), certainty: "derived" },
        { label: "BGT description", value: esc(a.label), certainty: "measured" },
        { label: "Area", value: m2(area(a.outline)), certainty: "measured" },
      ],
      source: "BGT (Basisregistratie Grootschalige Topografie), CC0",
      how: "Current BGT road, path, green and water objects. Historical versions are ignored. Narrow footpaths count as public (safe default).",
      raw: a,
    };
  }
  if (type === "edge") {
    const run = ctx.edges[Number(id)];
    if (!run) return undefined;
    return {
      title: `Plot edge: ${EDGE_TEXT[run.kind]?.label ?? run.kind}`,
      rows: [
        { label: "Length", value: m(run.lengthM), certainty: "derived" },
        {
          label: "Other side",
          value: run.otherSide ? esc(run.otherSide) : "—",
          certainty: run.kind === "unknown" ? "unknown" : "derived",
        },
      ],
      source: "Derived by the engine from BRK, BAG and BGT",
      how: "We walk along the plot boundary in 25 cm steps and look 50 cm outside. What we find there decides the edge type. A shared wall is where the house wall meets a neighbouring building.",
      raw: run,
    };
  }
  return undefined;
}

export function renderInspector(
  ctx: PlotContext | undefined,
  key: string | undefined,
  developer: boolean,
): string {
  if (!ctx || !key)
    return `<h3>Inspector</h3><p class="inspector-empty">Click anything on the plan to see what we know about it and where it comes from.</p>`;
  const v = describe(ctx, key);
  if (!v)
    return `<h3>Inspector</h3><p class="inspector-empty">Nothing to show for this object.</p>`;
  return `<h3>${esc(v.title)}</h3>
    <dl class="facts">${v.rows.map((r) => `<dt>${esc(r.label)}</dt><dd>${r.value}${certPill(r.certainty)}</dd>`).join("")}</dl>
    <p class="small muted" style="margin:12px 0 4px"><strong>Source.</strong> ${esc(v.source)}</p>
    <p class="small muted" style="margin:0"><strong>How we know.</strong> ${esc(v.how)}</p>
    ${key.startsWith("outbuilding:") ? askOutbuilding(ctx, key.slice("outbuilding:".length)) : ""}
    ${developer ? `<pre class="raw mono">${esc(JSON.stringify(v.raw, null, 1))}</pre>` : ""}`;
}

function askOutbuilding(ctx: PlotContext, id: string): string {
  const k = answerKey(ctx, id);
  const current = getAnswer(k);
  const chip = (label: string, value: string) =>
    `<button class="chip${current === value || (!current && value === "") ? " on" : ""}" data-answer="${esc(value)}" data-target="${esc(k)}">${esc(label)}</button>`;
  return `<div class="ask"><div class="small"><strong>Do you know what this is?</strong> The registers don't record it. Optional.</div>
    <div class="ask-options">${OUTBUILDING_KINDS.map((o) => chip(o, o)).join("")}${chip("Don't know", "")}</div></div>`;
}

/** Wire the answer chips inside an Inspector element; calls `changed` after an answer. */
export function bindAnswers(el: HTMLElement, changed: () => void): void {
  el.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLElement>("[data-answer]");
    if (!btn) return;
    setAnswer(btn.dataset.target ?? "", btn.dataset.answer ?? "");
    changed();
  });
}
