/**
 * Builds everything the engine needs about one address, step by step, with a trace.
 *
 * Critical path (ADR-030): address object and plot outline. Without them nothing can be
 * checked, so a failure stops the run with a clear message. Every other step degrades:
 * the run continues and the gap is recorded as a flag and in the trace.
 *
 * Real-data rules learned from the probe of 24-11-2026:
 *  - Narrow footpaths include pavements, so they are treated as public (safe default), with a flag.
 *  - BGT returns historical objects; only those with eind_registratie = null are current.
 *  - BAG returns demolished and wrongly-registered buildings; only in-use statuses count.
 *  - BRK parcels carry status_historie_code; "G" = valid.
 */
import {
  area,
  classifyEdges,
  distanceBetween,
  orientedBox,
  plotFrame,
  plotLayout,
  type PlotFrame,
  type PlotLayout,
  contains,
  deriveHouseType,
  SafeError,
  type EdgeRun,
  type HouseType,
  type Point,
  type Polygon,
  type PublicArea,
  type PublicAreaKind,
  type Tracer,
} from "@vergunbuy/engine";
import type { FetchFn } from "./http.ts";
import type { Address } from "./sources/locatieserver.ts";
import { num, OGC, ogcItems, outerRings, str, type Bbox, type Feature } from "./sources/ogc.ts";
import { fetchHeights, type BuildingHeights } from "./sources/threedbag.ts";

export interface Building {
  id: string;
  outline: Polygon;
  bouwjaar?: number;
  status: string;
  documentdatum?: string;
  documentnummer?: string;
  /** Number of addresses (verblijfsobjecten) in the building; 0 for most sheds and garages. */
  addresses?: number;
  /** BAG use, e.g. "woonfunctie". Absent for buildings without an address. */
  use?: string;
  heights?: BuildingHeights;
  /** Plain description. For outbuildings this is an assumption: BAG does not record the type. */
  label?: string;
  lengthM?: number;
  widthM?: number;
}

export interface Tree {
  id: string;
  at: Point;
  /** Assumed crown diameter: the register has a point only, no size. */
  crownM: number;
  registeredAt?: string;
}

export interface Exit {
  id: string;
  outline: Polygon;
  /** Length of plot boundary that touches the driveway crossing. */
  alongPlotM: number;
  registeredAt?: string;
}

export interface Measurements {
  houseLengthM?: number;
  houseWidthM?: number;
  houseHeightM?: number;
  /** Shortest distance from the house to public area. */
  houseToPublicM?: number;
  /** Plot boundary length on public area. */
  frontageM: number;
}

export type FlagCode =
  | "MULTIPLE_HOUSE_BUILDINGS"
  | "HOUSE_NOT_ON_PLOT"
  | "PUBLIC_AREA_UNKNOWN"
  | "POSSIBLE_ACHTERPAD"
  | "WATER_NEARBY"
  | "NEIGHBOURS_UNKNOWN"
  | "OUTBUILDINGS_ON_PLOT"
  | "HEIGHTS_MISSING"
  | "CHANGED_BETWEEN_SCANS"
  | "NO_EXIT_FOUND"
  | "TREES_UNKNOWN";

export interface Flag {
  code: FlagCode;
  detail: string;
}

export interface SourceInfo {
  name: string;
  licence: string;
  fetchedAt: string;
  objects: number;
}

export interface PlotContext {
  address: Address;
  plot: { id: string; outline: Polygon; areaM2: number; registeredAreaM2?: number };
  house: Building[];
  outbuildings: Building[];
  neighbours: Building[];
  /** Other parcels nearby, for drawing context only. */
  nearbyParcels: { id: string; outline: Polygon }[];
  publicAreas: (PublicArea & { label: string; registeredAt?: string })[] | null;
  trees: Tree[] | null;
  hedges: { id: string; outline: Polygon }[];
  exits: Exit[];
  measurements: Measurements;
  /** The plot's own frame (street at the bottom) and its main dimensions. */
  frame: PlotFrame;
  layout: PlotLayout;
  edges: EdgeRun[];
  houseType: HouseType;
  flags: Flag[];
  sources: SourceInfo[];
}

const IN_USE = new Set([
  "Pand in gebruik",
  "Pand in gebruik (niet ingemeten)",
  "Verbouwing pand",
  "Sloopvergunning verleend",
]);

/** Registration date of a BGT object, as a spreadable optional field. */
const registered = (f: Feature): { registeredAt?: string } => {
  const t = str(f.properties.tijdstip_registratie);
  return t ? { registeredAt: t.slice(0, 10) } : {};
};

const isCurrentBgt = (f: Feature) =>
  f.properties.eind_registratie === null || f.properties.eind_registratie === undefined;

/** Narrow footpath = likely a rear path serving plots only (ADR-017). Width ≈ 2·area / perimeter. */
function widthM(poly: Polygon): number {
  let perimeter = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a && b) perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return perimeter === 0 ? 0 : (2 * area(poly)) / perimeter;
}

function bboxOf(poly: Polygon, margin: number): Bbox {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  return [
    Math.min(...xs) - margin,
    Math.min(...ys) - margin,
    Math.max(...xs) + margin,
    Math.max(...ys) + margin,
  ];
}

const centroid = (poly: Polygon): Point => [
  poly.reduce((s, p) => s + p[0], 0) / poly.length,
  poly.reduce((s, p) => s + p[1], 0) / poly.length,
];

function toBuilding(f: Feature): Building[] {
  return outerRings(f.geometry).map((outline, i) => {
    const b: Building = {
      id: `${str(f.properties.identificatie) ?? String(f.id)}${i ? `-${i}` : ""}`,
      outline,
      status: str(f.properties.status) ?? "unknown",
    };
    const bouwjaar = num(f.properties.bouwjaar);
    const documentdatum = str(f.properties.documentdatum);
    const documentnummer = str(f.properties.documentnummer);
    if (bouwjaar !== undefined) b.bouwjaar = bouwjaar;
    if (documentdatum) b.documentdatum = documentdatum;
    if (documentnummer) b.documentnummer = documentnummer;
    const addresses = num(f.properties.aantal_verblijfsobjecten);
    if (addresses !== undefined) b.addresses = addresses;
    const use = str(f.properties.gebruiksdoel);
    if (use) b.use = use;
    const box = orientedBox(outline);
    b.lengthM = box.lengthM;
    b.widthM = box.widthM;
    return b;
  });
}

/**
 * BAG does not record what an outbuilding is. We describe it from size, height and whether
 * it has an address. This is an assumption and is labelled as such in the Inspector.
 */
export function describeOutbuilding(b: Building): string {
  const a = area(b.outline);
  const h = b.heights?.heightM;
  if ((b.addresses ?? 0) > 0)
    return b.use ? `Building with an address (${b.use})` : "Building with an address";
  if (a < 8) return "Small shed or storage";
  if (h !== undefined && h <= 3.5 && a <= 45) return "Single-storey shed, garage or garden room";
  if (h !== undefined && h > 3.5) return "Larger outbuilding (taller than one storey)";
  return "Outbuilding (type not registered)";
}

export async function buildPlotContext(
  address: Address,
  tracer: Tracer,
  fetchFn?: FetchFn,
): Promise<PlotContext> {
  const flags: Flag[] = [];
  const sources: SourceInfo[] = [];
  const now = () => new Date().toISOString();
  const [x, y] = address.pointRd;
  const near: Bbox = [x - 5, y - 5, x + 5, y + 5];

  // 1. Address object → the BAG building(s) it is in. Critical.
  const housePandUuids = await tracer.step(
    "bag-address",
    "Find the building for this address (BAG)",
    async (ctx) => {
      const vbos = await ogcItems(OGC.bag, "verblijfsobject", near, ctx, fetchFn);
      const vbo = vbos.find((f) => f.properties.identificatie === address.bagVerblijfsobjectId);
      if (!vbo)
        throw new SafeError(
          "ADDRESS_OBJECT_NOT_FOUND",
          "The building register has no object for this address.",
        );
      const hrefs = (vbo.properties["pand.href"] as string[] | undefined) ?? [];
      const uuids = hrefs.map((h) => h.split("/").pop() ?? "");
      ctx.summarize(`Address is in ${uuids.length} building(s)`);
      return new Set(uuids);
    },
  );

  // 2. Plot outline: the valid parcel containing the address point. Critical.
  const { plot, parcels } = await tracer.step(
    "brk-plot",
    "Find the plot (BRK cadastral map)",
    async (ctx) => {
      const features = await ogcItems(
        OGC.brk,
        "perceel",
        [x - 40, y - 40, x + 40, y + 40],
        ctx,
        fetchFn,
      );
      const valid = features.filter((f) => (f.properties.status_historie_code ?? "G") === "G");
      for (const f of valid) {
        const outline = outerRings(f.geometry).find((ring) => contains(ring, [x, y]));
        if (outline) {
          const id =
            `${str(f.properties.kadastrale_gemeente_waarde) ?? ""} ${str(f.properties.sectie) ?? ""} ${num(f.properties.perceelnummer) ?? ""}`.trim();
          const registered = num(f.properties.kadastrale_grootte_waarde);
          ctx.summarize(`Plot ${id}, ${Math.round(area(outline))} m² drawn`);
          sources.push({
            name: "BRK Kadastrale kaart",
            licence: "CC BY 4.0",
            fetchedAt: now(),
            objects: valid.length,
          });
          return {
            plot: {
              id,
              outline,
              areaM2: Math.round(area(outline)),
              ...(registered ? { registeredAreaM2: registered } : {}),
            },
            parcels: valid,
          };
        }
      }
      throw new SafeError(
        "PLOT_NOT_FOUND",
        "We could not find a plot at this address on the cadastral map.",
      );
    },
  );

  const work = bboxOf(plot.outline, 25);

  // 3. Buildings: house, outbuildings, neighbours. Degrades.
  let house: Building[] = [];
  let outbuildings: Building[] = [];
  let neighbours: Building[] = [];
  try {
    await tracer.step("bag-buildings", "Buildings on and around the plot (BAG)", async (ctx) => {
      const features = await ogcItems(OGC.bag, "pand", work, ctx, fetchFn);
      const current = features.filter((f) => IN_USE.has(str(f.properties.status) ?? ""));
      const dropped = features.length - current.length;
      for (const f of current) {
        const buildings = toBuilding(f);
        if (housePandUuids.has(String(f.id))) house.push(...buildings);
        else
          for (const b of buildings) {
            if (contains(plot.outline, centroid(b.outline))) outbuildings.push(b);
            else neighbours.push(b);
          }
      }
      sources.push({
        name: "BAG",
        licence: "Public domain",
        fetchedAt: now(),
        objects: current.length,
      });
      ctx.summarize(
        `${house.length} house, ${outbuildings.length} other on plot, ${neighbours.length} nearby; ignored ${dropped} demolished or invalid`,
      );
      if (house.length === 0) ctx.degrade("house outline not found");
    });
  } catch {
    house = [];
    outbuildings = [];
    neighbours = [];
    flags.push({
      code: "NEIGHBOURS_UNKNOWN",
      detail: "Buildings could not be loaded; shared walls cannot be detected.",
    });
  }
  if (house.length > 1)
    flags.push({
      code: "MULTIPLE_HOUSE_BUILDINGS",
      detail: `${house.length} building outlines belong to this address.`,
    });
  if (house.some((h) => !contains(plot.outline, centroid(h.outline))))
    flags.push({
      code: "HOUSE_NOT_ON_PLOT",
      detail: "The house outline is mostly outside the plot found for this address.",
    });
  if (outbuildings.length > 0)
    flags.push({
      code: "OUTBUILDINGS_ON_PLOT",
      detail: `${outbuildings.length} other building(s) registered on this plot.`,
    });

  // 3b. Heights, roof type and change flags from 3D BAG. Degrades.
  try {
    await tracer.step("3dbag-heights", "Heights and roofs (3D BAG)", async (ctx) => {
      const heights = await fetchHeights(work, ctx, fetchFn);
      let matched = 0;
      for (const b of [...house, ...outbuildings, ...neighbours]) {
        const h = heights.get(b.id.replace(/-\d+$/, ""));
        if (h) {
          b.heights = h;
          matched++;
        }
      }
      sources.push({ name: "3D BAG", licence: "CC BY 4.0", fetchedAt: now(), objects: matched });
      const scan = house[0]?.heights?.scanYear;
      ctx.summarize(`Heights for ${matched} buildings${scan ? `, height scan of ${scan}` : ""}`);
      if (house.length > 0 && !house.some((h) => h.heights?.heightM !== undefined))
        ctx.degrade("no height for the house");
    });
  } catch {
    flags.push({ code: "HEIGHTS_MISSING", detail: "Building heights could not be loaded." });
  }
  for (const b of outbuildings) b.label = describeOutbuilding(b);
  for (const b of house) b.label = "House";
  const changed = house.find(
    (h) => h.heights?.changedBetweenScans.ahn3ToAhn4 || h.heights?.changedBetweenScans.ahn4ToAhn5,
  );
  if (changed) {
    const c = changed.heights?.changedBetweenScans;
    flags.push({
      code: "CHANGED_BETWEEN_SCANS",
      detail: `The national height scans show a change to the house between ${c?.ahn3ToAhn4 ? "2014–2019 and 2020–2022" : "2020–2022 and 2023–2025"}. This can mean an extension or roof change.`,
    });
  }

  // 3c. Registered street trees and hedges (BGT). Garden trees are not registered anywhere. Degrades.
  let trees: Tree[] | null = null;
  let hedges: { id: string; outline: Polygon }[] = [];
  try {
    await tracer.step("bgt-trees", "Registered trees and hedges (BGT)", async (ctx) => {
      const [points, areas] = await Promise.all([
        ogcItems(OGC.bgt, "vegetatieobject_punt", work, ctx, fetchFn),
        ogcItems(OGC.bgt, "vegetatieobject_vlak", work, ctx, fetchFn),
      ]);
      trees = points
        .filter(
          (f) =>
            isCurrentBgt(f) &&
            str(f.properties.plus_type) === "boom" &&
            f.geometry?.type === "Point",
        )
        .map((f) => {
          const c = f.geometry?.coordinates as number[];
          const t: Tree = {
            id: str(f.properties.lokaal_id) ?? String(f.id),
            at: [Number(c[0]), Number(c[1])],
            crownM: 4,
          };
          const reg = str(f.properties.tijdstip_registratie);
          if (reg) t.registeredAt = reg.slice(0, 10);
          return t;
        });
      hedges = areas
        .filter((f) => isCurrentBgt(f))
        .flatMap((f) =>
          outerRings(f.geometry).map((outline) => ({
            id: str(f.properties.lokaal_id) ?? String(f.id),
            outline,
          })),
        );
      ctx.summarize(
        `${trees.length} registered trees, ${hedges.length} hedges nearby (garden trees are not registered)`,
      );
    });
  } catch {
    flags.push({ code: "TREES_UNKNOWN", detail: "Registered trees could not be loaded." });
  }

  // Street-name labels (BGT): tell us which side of the plot faces the address's own street.
  let streetLabels: { at: Point; name: string }[] = [];

  // 4. Public area from BGT (current objects only). Degrades to "unknown" edges, never to "neighbour".
  let publicAreas: (PublicArea & { label: string; registeredAt?: string })[] | null = null;
  try {
    publicAreas = await tracer.step(
      "bgt-public",
      "Streets, paths, green and water (BGT)",
      async (ctx) => {
        const [roads, green, water] = await Promise.all([
          ogcItems(OGC.bgt, "wegdeel", work, ctx, fetchFn),
          ogcItems(OGC.bgt, "begroeidterreindeel", work, ctx, fetchFn),
          ogcItems(OGC.bgt, "waterdeel", work, ctx, fetchFn),
        ]);
        streetLabels = await ogcItems(OGC.bgt, "openbareruimtelabel", work, ctx, fetchFn)
          .then((fs) =>
            fs
              .filter((f) => isCurrentBgt(f) && f.geometry?.type === "Point")
              .map((f) => {
                const c = f.geometry?.coordinates as number[];
                return {
                  at: [Number(c[0]), Number(c[1])] as Point,
                  name: str(f.properties.openbareruimtenaam) ?? "",
                };
              })
              .filter((l) => l.name.toLowerCase() === address.street.toLowerCase()),
          )
          .catch(() => []);
        const areas: (PublicArea & { label: string; registeredAt?: string })[] = [];
        let history = 0;
        let narrowPaths = 0;
        const add = (
          fs: Feature[],
          kindOf: (f: Feature, ring: Polygon) => PublicAreaKind | null,
          labelOf: (f: Feature) => string,
        ) => {
          for (const f of fs) {
            if (!isCurrentBgt(f)) {
              history++;
              continue;
            }
            outerRings(f.geometry).forEach((ring, i) => {
              const kind = kindOf(f, ring);
              if (kind)
                areas.push({
                  id: `${str(f.properties.lokaal_id) ?? f.id}${i ? `-${i}` : ""}`,
                  kind,
                  outline: ring,
                  label: labelOf(f),
                  ...registered(f),
                });
            });
          }
        };
        add(
          roads,
          (f, ring) => {
            const functie = str(f.properties.functie) ?? "";
            // Narrow footpaths may be rear paths (not public), but pavements are narrow too.
            // Treating them as public is the safe default: it can block a position, never wrongly allow one.
            if (functie === "voetpad" && widthM(ring) < 2.5) narrowPaths++;
            return functie.includes("voetpad") || functie.includes("fietspad")
              ? "footpath"
              : "road";
          },
          (f) => str(f.properties.functie) ?? "road",
        );
        // Public green (plantsoen etc.). Private gardens are "erf" in onbegroeidterreindeel, which we do not load.
        add(
          green,
          (f) => (str(f.properties.fysiek_voorkomen) === "groenvoorziening" ? "green" : null),
          (f) => str(f.properties.plus_fysiek_voorkomen) ?? "green",
        );
        add(
          water,
          () => "water",
          (f) => str(f.properties.type) ?? "water",
        );
        sources.push({ name: "BGT", licence: "CC0", fetchedAt: now(), objects: areas.length });
        ctx.summarize(
          `${areas.length} current public areas; ignored ${history} historical records`,
        );
        if (narrowPaths > 0)
          flags.push({
            code: "POSSIBLE_ACHTERPAD",
            detail: `${narrowPaths} narrow footpath(s) nearby are treated as public. If one is a rear path serving only the plots, more positions may be allowed.`,
          });
        return areas;
      },
    );
  } catch {
    flags.push({
      code: "PUBLIC_AREA_UNKNOWN",
      detail: "Streets and public areas could not be loaded; plot edges toward them are unknown.",
    });
  }

  // 5. Classify plot edges (engine).
  const mainHouse = [...house].sort((a, b) => area(b.outline) - area(a.outline))[0];
  const edges = await tracer.step("classify-edges", "Classify every plot edge", (ctx) => {
    const runs = classifyEdges({
      plot: plot.outline,
      house: mainHouse?.outline ?? [],
      neighbourBuildings: neighbours.map((n) => ({ id: n.id, outline: n.outline })),
      publicAreas: publicAreas?.map(({ id, kind, outline }) => ({ id, kind, outline })) ?? null,
    });
    const kinds = new Set(runs.map((r) => r.kind));
    if (kinds.has("water"))
      flags.push({
        code: "WATER_NEARBY",
        detail: "Water borders the plot; whether it counts as public is not known from data.",
      });
    ctx.summarize(`${runs.length} edge runs`);
    if (kinds.has("unknown")) ctx.degrade("some edges unknown");
    return runs;
  });

  // 6. Existing exits: registered driveway crossings ("inrit") that touch the plot.
  const exits: Exit[] = [];
  for (const a of publicAreas ?? []) {
    if (a.label !== "inrit") continue;
    if (distanceBetween(a.outline, plot.outline) > 0.6) continue;
    let along = 0;
    for (const run of edges) {
      if (run.otherSide === a.id) along += run.lengthM;
    }
    exits.push({
      id: a.id,
      outline: a.outline,
      alongPlotM: Math.round(along * 10) / 10,
      ...(a.registeredAt ? { registeredAt: a.registeredAt } : {}),
    });
  }
  if (publicAreas && exits.length === 0)
    flags.push({
      code: "NO_EXIT_FOUND",
      detail:
        "No registered driveway crossing touches this plot. A carport may need a new exit, which needs its own permit.",
    });

  // 7. The plot's own frame: street at the bottom.
  const kindById = new Map((publicAreas ?? []).map((a) => [a.id, a.kind]));
  const frame = plotFrame(plot.outline, edges, streetLabels, (id) =>
    id ? kindById.get(id) : undefined,
  );
  const layout = plotLayout(frame, plot.outline, mainHouse?.outline);

  // 8. Measurements.
  const publicOutlines = (publicAreas ?? [])
    .filter((a) => a.kind !== "water")
    .map((a) => a.outline);
  const houseToPublic = mainHouse
    ? Math.min(
        ...publicOutlines.map((o) => distanceBetween(mainHouse.outline, o)),
        ...(publicOutlines.length ? [] : [Infinity]),
      )
    : undefined;
  const measurements: Measurements = {
    frontageM:
      Math.round(edges.filter((e) => e.kind === "public").reduce((s, e) => s + e.lengthM, 0) * 10) /
      10,
    ...(mainHouse?.lengthM ? { houseLengthM: mainHouse.lengthM } : {}),
    ...(mainHouse?.widthM ? { houseWidthM: mainHouse.widthM } : {}),
    ...(mainHouse?.heights?.heightM !== undefined
      ? { houseHeightM: mainHouse.heights.heightM }
      : {}),
    ...(houseToPublic !== undefined && Number.isFinite(houseToPublic)
      ? { houseToPublicM: Math.round(houseToPublic * 10) / 10 }
      : {}),
  };

  return {
    address,
    plot,
    house,
    outbuildings,
    neighbours,
    nearbyParcels: parcels
      .flatMap((f) =>
        outerRings(f.geometry).map((outline) => ({
          id: str(f.properties.identificatie_lokaal_id) ?? "",
          outline,
        })),
      )
      .filter((p) => p.outline !== plot.outline),
    publicAreas,
    trees,
    hedges,
    exits,
    measurements,
    frame,
    layout,
    edges,
    houseType: deriveHouseType(edges),
    flags,
    sources,
  };
}
