/**
 * Inspector (ADR-023): shows what we know about one clicked object, how sure we are,
 * where it comes from and how it was derived. The developer layer adds the raw record.
 */
import type { PlotContext } from "@vergunbuy/data";
import { area } from "@vergunbuy/engine";
import { EDGE_TEXT, esc, m, m2 } from "./format.ts";

interface Row {
  label: string;
  value: string;
  certainty?: "measured" | "derived" | "assumed" | "unknown";
}

interface View {
  title: string;
  rows: Row[];
  source: string;
  how: string;
  raw: unknown;
}

const certPill = (c?: Row["certainty"]) =>
  c
    ? ` <span class="pill ${c === "measured" ? "ok" : c === "derived" ? "" : c === "assumed" ? "warn" : "bad"} cert">${c}</span>`
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
    const changed =
      b.documentdatum && b.bouwjaar && Number(b.documentdatum.slice(0, 4)) > b.bouwjaar + 1;
    return {
      title:
        type === "house"
          ? "House"
          : type === "outbuilding"
            ? "Other building on this plot"
            : "Neighbouring building",
      rows: [
        { label: "BAG id", value: esc(b.id), certainty: "measured" },
        { label: "Footprint (from above)", value: m2(area(b.outline)), certainty: "measured" },
        ...(b.bouwjaar
          ? [{ label: "Built", value: String(b.bouwjaar), certainty: "measured" as const }]
          : []),
        { label: "Status", value: esc(b.status), certainty: "measured" },
        ...(b.documentdatum
          ? [
              {
                label: "Last register document",
                value: `${esc(b.documentdatum)}${b.documentnummer ? ` (no. ${esc(b.documentnummer)})` : ""}`,
                certainty: "measured" as const,
              },
            ]
          : []),
        ...(type === "house" && changed
          ? [
              {
                label: "Possible later change",
                value:
                  "A register document is dated well after the build year. This can mean an extension; it is evidence, not proof.",
                certainty: "derived" as const,
              },
            ]
          : []),
      ],
      source: "BAG (Basisregistratie Adressen en Gebouwen), public domain",
      how:
        type === "house"
          ? "The building(s) linked to this address in the register. Demolished or wrongly registered buildings are ignored."
          : type === "outbuilding"
            ? "A registered building whose centre lies on this plot and that is not the house."
            : "A registered building near the plot. Used to detect shared walls.",
      raw: b,
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
    ${developer ? `<pre class="raw mono">${esc(JSON.stringify(v.raw, null, 1))}</pre>` : ""}`;
}
