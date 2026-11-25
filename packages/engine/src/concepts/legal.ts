/**
 * Legal facts about a plot and the exclusions they trigger in the carport rules
 * (omgevingsplan 22.28, 22.38, 22.39). Pure: the data layer gathers the facts, this decides.
 *
 * Every exclusion ends as one of:
 *  - "clear": the data shows the exclusion does not apply;
 *  - "applies": the data shows it applies (the excluded article cannot be used);
 *  - "depends-on-placement": it applies only where the carport would stand (e.g. inside an
 *    archaeology zone and 50 m² or more); the carport engine resolves it per position;
 *  - "unknown": the data needed is missing or incomplete. Never treated as clear.
 */
import {
  contains,
  distanceBetween,
  intersectionArea,
  type Point,
  type Polygon,
} from "../geometry.ts";

export type SourceStatus = "complete" | "incomplete" | "missing";

export interface ZoningObjectFact {
  planId: string;
  planName: string;
  kind: string;
  type: string | null;
  name: string;
  mainGroup: string | null;
  outlines: Polygon[];
}

export interface MonumentFact {
  register: "national" | "municipal";
  id: string;
  name: string;
  url?: string;
  /** Location as registered (a point for national monuments). */
  at?: Point;
  /** Where it is relative to the plot. */
  relation: "on-plot" | "adjacent-parcel" | "nearby";
}

/** A registered unit (BAG verblijfsobject) that is not a home, near the plot. */
export interface BusinessUnit {
  at: Point;
  use: string;
}

export interface LegalFacts {
  /** Non-residential BAG units within 50 m (shops, workshops, storage); null when not read. */
  businessUnits?: BusinessUnit[] | null;
  zoning: {
    status: SourceStatus;
    plans: { id: string; name: string; date: string | null }[];
    objects: ZoningObjectFact[];
  };
  monuments: { status: SourceStatus; items: MonumentFact[]; municipalRegisterCheckedOn: string };
  protectedViews: { status: SourceStatus; names: string[] };
}

export type ExclusionState = "clear" | "applies" | "depends-on-placement" | "unknown";

export interface ExclusionResult {
  ruleId: string;
  state: ExclusionState;
  reason: string;
  /** Areas on the plot where the exclusion applies (for depends-on-placement). */
  zones?: Polygon[];
}

/** Largest distance (m) in the Bal articles listed in omgevingsplan 22.39 c (LNG tank, 4.472c). */
export const BAL_MAX_DISTANCE_M = 120;

/**
 * Zoning that could hold an activity with a Bal safety distance (22.39 c), with the largest
 * distance that kind of site can have (Bal tables 4.421, 4.472c, 4.484, 4.899 and articles
 * 4.524 to 4.1101): LNG tanks at fuel stations 120 m; biogas and propane tanks 50 m; gas pressure
 * stations up to 25 m; packaged dangerous goods 20 m.
 */
const RISK_SOURCES: {
  test: RegExp;
  withinM: number;
  what: string;
  /**
   * What must be present inside the zone, within the distance, for it to count: the zone itself
   * (conservative); a building block (a farm without a farmyard holds no tank); or a registered
   * non-residential unit (a centre or mixed-use zone with only homes in reach holds no store).
   */
  needs: "zone" | "block" | "business-unit";
}[] = [
  {
    test: /motorbrandstof|tankstation|lpg|lng|cng|waterstof/i,
    withinM: 120,
    what: "a fuel station",
    needs: "zone",
  },
  {
    test: /nutsvoorziening|gasdruk|gasontvang/i,
    withinM: 25,
    what: "a utility site (gas pressure station)",
    needs: "zone",
  },
  {
    test: /^bedrijf|bedrijventerrein|industrie/i,
    withinM: 50,
    what: "a business site (propane tank, biogas, dangerous goods)",
    needs: "zone",
  },
  { test: /^agrarisch/i, withinM: 50, what: "a farm (propane tank or biogas)", needs: "block" },
  {
    test: /detailhandel|centrum|gemengd/i,
    withinM: 20,
    what: "a shop or mixed-use site (packaged dangerous goods)",
    needs: "business-unit",
  },
];

const BUSINESS_USE = /winkel|industrie|overige gebruiks|bijeenkomst|kantoor/i;

const ARCHAEOLOGY = /archeolog/i;
const SAFETY_ZONE =
  /veiligheidszone|munitie|explosie|bevi|plaatsgebonden risico|risicocontour|lpg/i;
const PIPELINE_STRIP = /^leiding\s*-(?!\s*hoogspanning)/i;
const PROTECTED_VIEW = /beschermd (stads|dorps)gezicht|rijksbeschermd/i;

const overlaps = (a: Polygon, b: Polygon) => intersectionArea(a, b) > 0.05;

/** Evaluates the exclusions of the carport rule set for a plot, from the gathered facts. */
export function assessExclusions(plot: Polygon, facts: LegalFacts): ExclusionResult[] {
  const out: ExclusionResult[] = [];
  const zoningKnown = facts.zoning.status === "complete";
  const atPlot = facts.zoning.objects.filter((o) => o.outlines.some((p) => overlaps(p, plot)));

  // Monuments (22.28 first/second paragraph, 22.38 a).
  const monumentState = (): ExclusionResult => {
    if (facts.monuments.status !== "complete")
      return {
        ruleId: "",
        state: "unknown",
        reason: "The monument registers could not be read completely.",
      };
    const on = facts.monuments.items.filter((m) => m.relation === "on-plot");
    const adjacent = facts.monuments.items.filter((m) => m.relation === "adjacent-parcel");
    if (on.length)
      return {
        ruleId: "",
        state: "applies",
        reason: `A monument stands on this plot: ${on.map((m) => m.name).join(", ")}.`,
      };
    if (adjacent.length)
      return {
        ruleId: "",
        state: "unknown",
        reason: `A monument stands on a neighbouring parcel (${adjacent.map((m) => m.name).join(", ")}). Whether work here counts as "at" (bij) that monument needs a check with the municipality.`,
      };
    return {
      ruleId: "",
      state: "clear",
      reason: `No national or municipal monument on or next to this plot (national register via RCE; municipal register checked on ${facts.monuments.municipalRegisterCheckedOn}).`,
    };
  };
  const m = monumentState();
  out.push({ ...m, ruleId: "ex-monument-2227" });

  // Protected town or village view (22.28 third paragraph, 22.38 b).
  const viewNames = [
    ...facts.protectedViews.names,
    ...atPlot.filter((o) => PROTECTED_VIEW.test(o.name)).map((o) => o.name),
  ];
  const view: ExclusionResult =
    facts.protectedViews.status !== "complete" || !zoningKnown
      ? {
          ruleId: "ex-village-view-2227",
          state: "unknown",
          reason: "The protected-views data could not be read completely.",
        }
      : viewNames.length
        ? {
            ruleId: "ex-village-view-2227",
            state: "applies",
            reason: `In a nationally protected town or village view: ${viewNames.join(", ")}.`,
          }
        : {
            ruleId: "ex-village-view-2227",
            state: "clear",
            reason:
              "Not in a nationally protected town or village view (RCE register and zoning plans).",
          };
  out.push(view);

  // Monuments or protected views switch off 22.36 as well (22.38).
  out.push({
    ruleId: "ex-monument-village-2236",
    state:
      m.state === "applies" || view.state === "applies"
        ? "applies"
        : m.state === "unknown" || view.state === "unknown"
          ? "unknown"
          : "clear",
    reason: [m.reason, view.reason].join(" "),
  });

  // Archaeology (22.28 fourth paragraph): only for a carport of 50 m² or more inside the zone.
  if (!zoningKnown)
    out.push({
      ruleId: "ex-archaeology-2227",
      state: "unknown",
      reason: "The zoning plans could not be read completely.",
    });
  else {
    const zones = atPlot.filter((o) => ARCHAEOLOGY.test(o.name));
    out.push(
      zones.length
        ? {
            ruleId: "ex-archaeology-2227",
            state: "depends-on-placement",
            reason: `The zoning plan has archaeology rules here (${[...new Set(zones.map((z) => `"${z.name}" in ${z.planName}`))].join(", ")}). A carport smaller than 50 m² is not affected; a larger one inside this zone is not permit-free.`,
            zones: zones.flatMap((z) => z.outlines),
          }
        : {
            ruleId: "ex-archaeology-2227",
            state: "clear",
            reason: "No archaeology rules in the zoning plans on this plot.",
          },
    );
  }

  // External safety (22.39): zones in the zoning plans, pipeline strips, and Bal distances.
  if (!zoningKnown)
    out.push({
      ruleId: "ex-safety-2236",
      state: "unknown",
      reason: "The zoning plans could not be read completely.",
    });
  else {
    const zones = atPlot.filter((o) => SAFETY_ZONE.test(o.name) || PIPELINE_STRIP.test(o.name));
    // Installations stand where building is allowed: inside a building block (bouwvlak) when the
    // zone has one. A zone without any building block is measured whole (conservative).
    const blocks = facts.zoning.objects.filter((o) => o.kind === "bouwvlakken");
    const sources = facts.zoning.objects
      .filter((o) => o.kind === "bestemmingsvlakken" && !o.outlines.some((p) => overlaps(p, plot)))
      .flatMap((o) => {
        const src = RISK_SOURCES.find((r) => r.test.test(o.name) || r.test.test(o.mainGroup ?? ""));
        if (!src) return [];
        const inZone = blocks
          .filter((b) => b.planId === o.planId)
          .flatMap((b) => b.outlines)
          .filter((b) => o.outlines.some((z) => overlaps(z, b)));
        if (src.needs === "block" && !inZone.length) return [];
        if (src.needs === "business-unit") {
          // Unknown units data: fall back to the zone itself (conservative).
          if (facts.businessUnits) {
            const units = facts.businessUnits.filter(
              (u) =>
                BUSINESS_USE.test(u.use) &&
                o.outlines.some((z) => contains(z, u.at)) &&
                distanceBetween([u.at, u.at, u.at], plot) <= src.withinM,
            );
            if (!units.length) return [];
          }
        }
        const measured = inZone.length ? inZone : o.outlines;
        const d = Math.min(...measured.map((p) => distanceBetween(p, plot)));
        return d <= src.withinM
          ? [
              {
                name: o.name,
                what: src.what,
                d: Math.round(d),
                withinM: src.withinM,
                block: inZone.length > 0,
              },
            ]
          : [];
      });
    if (zones.length)
      out.push({
        ruleId: "ex-safety-2236",
        state: "depends-on-placement",
        reason: `Safety zone or pipeline strip on this plot (${[...new Set(zones.map((z) => z.name))].join(", ")}): where it lies, a carport is not allowed by law and the zoning plan decides.`,
        zones: zones.flatMap((z) => z.outlines),
      });
    else if (sources.length)
      out.push({
        ruleId: "ex-safety-2236",
        state: "unknown",
        reason: `Within the Bal safety distance of ${sources.map((s) => `${s.what} ("${s.name}", ${s.block ? "its building area is " : ""}${s.d} m away, matters within ${s.withinM} m)`).join("; ")}. Whether it actually holds such an installation is not in open data; check the risk map (Atlas Leefomgeving).`,
      });
    else
      out.push({
        ruleId: "ex-safety-2236",
        state: "clear",
        reason: `No safety zone or pipeline strip on the plot, and no zoning within ${BAL_MAX_DISTANCE_M} m that could hold an installation with a Bal safety distance.`,
      });
  }
  return out;
}

/** Whether a carport outline would sit inside any of the given zones. */
export function insideAnyZone(outline: Polygon, zones: Polygon[]): boolean {
  return zones.some((z) => overlaps(z, outline) || outline.some((p) => contains(z, p)));
}
