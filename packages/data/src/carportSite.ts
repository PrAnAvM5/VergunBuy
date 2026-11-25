/**
 * Builds the carport engine's input from a plot context: every geometry into the plot's own frame
 * (street at the bottom), access as boundary stretches, obstacles as cells, the rule exclusions,
 * signs of a house extension, and the rule set's parameters and freshness.
 */
import {
  at,
  carportGate,
  intersectionArea,
  lerp,
  polyToLocal,
  ruleFreshness,
  sideOfEdge,
  toLocal,
  type AreaTableParams,
  type CarportSite,
  type CurrentVersion,
  type Point,
  type Polygon,
  type RuleSet,
} from "@vergunbuy/engine";
import type { PlotContext } from "./plotContext.ts";

export interface FreshnessInput {
  /** Current versions from the DSO (live or the daily snapshot); null when unknown. */
  current: { inForce: CurrentVersion[]; drafts: CurrentVersion[] } | null;
  /** When those versions were read (ISO), and from where, for the explanation. */
  checkedAt: string | null;
  source: "live" | "snapshot" | "none";
}

/** Snapshot older than this cannot vouch for the rules being current. */
export const FRESHNESS_MAX_AGE_DAYS = 7;

function segmentOf(plot: Polygon, edge: number, from: number, to: number): [Point, Point] {
  const a = at(plot, edge);
  const b = at(plot, edge + 1);
  return [lerp(a, b, from), lerp(a, b, to)];
}

/** The stretch of the plot boundary lying within 1 m of a driveway crossing. */
function exitStretches(plot: Polygon, exit: Polygon): [Point, Point][] {
  const out: [Point, Point][] = [];
  const near = (p: Point) =>
    exit.some((_, i) => {
      const a = exit[i]!;
      const b = exit[(i + 1) % exit.length]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = Math.max(
        0,
        Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
      );
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) <= 1;
    });
  for (let e = 0; e < plot.length; e++) {
    const a = at(plot, e);
    const b = at(plot, e + 1);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(2, Math.ceil(len / 0.25));
    let start = -1;
    for (let i = 0; i <= n; i++) {
      const inside = near(lerp(a, b, i / n));
      if (inside && start < 0) start = i;
      if ((!inside || i === n) && start >= 0) {
        const end = inside ? i : i - 1;
        if (end > start) out.push([lerp(a, b, start / n), lerp(a, b, end / n)]);
        start = -1;
      }
    }
  }
  return out;
}

export function carportSite(
  ctx: PlotContext,
  rules: RuleSet,
  freshness: FreshnessInput,
): { site: CarportSite | null; gate: string | null } {
  const gate = carportGate(ctx.houseType, ctx.otherHomesOnPlot);
  if (gate) return { site: null, gate };
  const f = ctx.frame;
  const L = (p: Polygon) => polyToLocal(f, p);
  const plot = L(ctx.plot.outline);

  const house = ctx.house.map((h) => ({
    outline: L(h.outline),
    ...(h.heights?.heightM !== undefined ? { heightM: h.heights.heightM } : {}),
    ...(h.heights?.storeys !== undefined ? { storeys: h.heights.storeys } : {}),
    isDwelling: /woonfunctie/.test(h.use ?? ""),
  }));
  const overlapsPlot = (p: Polygon) => intersectionArea(p, ctx.plot.outline) > 0.05;
  const buildings = [
    ...ctx.outbuildings.map((b) => ({
      id: b.id,
      outline: L(b.outline),
      label: b.label ?? "an outbuilding",
      onPlot: true,
    })),
    ...ctx.neighbours
      .filter((b) => overlapsPlot(b.outline))
      .map((b) => ({
        id: b.id,
        outline: L(b.outline),
        label: "a neighbouring building",
        onPlot: false,
      })),
  ];
  const structures = ctx.structures.map((s) => ({
    id: s.id,
    outline: L(s.outline),
    label:
      s.type === "overkapping"
        ? "an existing canopy (registered roof without walls)"
        : s.type === "bassin"
          ? "a pool or basin"
          : `a registered structure (${s.type})`,
    roofed: s.type === "overkapping",
  }));

  // Public sides other than the front (corner plots); rear paths are not "public" here.
  const publicSides = [
    ...new Set(
      ctx.edges
        .filter((r) => r.kind === "public" && r.lengthM >= 1)
        .map((r) => sideOfEdge(f, ctx.plot.outline, r.edge))
        .filter((s): s is "left" | "right" | "rear" => s !== "front"),
    ),
  ];

  // Access: registered exits, else road contact, else across the pavement.
  const lvl = ctx.access.level;
  const level: CarportSite["access"]["level"] =
    lvl === "registered" ? "registered" : lvl === "possible" ? "possible" : "none";
  let entries: [Point, Point][] = [];
  if (lvl === "registered")
    entries = ctx.exits.flatMap((e) => exitStretches(ctx.plot.outline, e.outline));
  if (!entries.length)
    entries = ctx.carReachableEdges.map((r) => segmentOf(ctx.plot.outline, r.edge, r.from, r.to));
  if (!entries.length)
    entries = ctx.pavementRuns.map((r) => segmentOf(ctx.plot.outline, r.edge, r.from, r.to));
  const localEntries = entries.map(([a, b]) => [toLocal(f, a), toLocal(f, b)] as [Point, Point]);
  // Where a new exit could go (registered plots): road contact and pavement crossings.
  const frontage =
    lvl === "registered"
      ? [
          ...ctx.carReachableEdges.map((r) => segmentOf(ctx.plot.outline, r.edge, r.from, r.to)),
          ...(ctx.frontageRuns ?? []).map((r) => segmentOf(ctx.plot.outline, r.edge, r.from, r.to)),
        ].map(([a, b]) => [toLocal(f, a), toLocal(f, b)] as [Point, Point])
      : [];

  const obstacles = ctx.obstacles
    ? {
        cells: ctx.obstacles.obstacles.flatMap((o) =>
          o.cells.map((c, i) => ({
            at: toLocal(f, c),
            heightM: o.cellHeights[i] ?? 0,
            kind: o.kind,
            // The whole crown of a tree (2.5 m+) counts, also its lower edge (decision 2026-11-25).
            tree: o.kind !== "medium",
          })),
        ),
        cellM: ctx.obstacles.res,
        ...(ctx.house[0]?.heights?.scanYear ? { scanYear: ctx.house[0].heights.scanYear } : {}),
      }
    : null;

  const exclusions = ctx.legal.exclusions.map((e) => ({
    ...e,
    ...(e.zones ? { zones: e.zones.map(L) } : {}),
  }));

  const extensionEvidence = [
    ...ctx.permits.records
      .filter((r) => r.topics.includes("extension") && r.stage === "granted")
      .map((r) => `permit ${r.date?.slice(0, 4) ?? ""} for "${r.summary.slice(0, 80)}"`),
    ...ctx.house.flatMap((h) =>
      h.heights?.changedBetweenScans.ahn3ToAhn4 || h.heights?.changedBetweenScans.ahn4ToAhn5
        ? [
            `the height scans show the house changed ${h.heights.changedBetweenScans.ahn4ToAhn5 ? "after about 2020" : "between about 2014 and 2020"}`,
          ]
        : [],
    ),
  ];

  const areaEval = rules.rules.find((r) => r.id === "ia-area-limit")?.evaluation;
  const areaTable = (areaEval?.kind === "check"
    ? areaEval.params
    : {}) as unknown as AreaTableParams;

  const ageDays = freshness.checkedAt
    ? (Date.now() - Date.parse(freshness.checkedAt)) / 86400_000
    : Infinity;
  const fresh =
    freshness.current && ageDays <= FRESHNESS_MAX_AGE_DAYS
      ? ruleFreshness(rules, freshness.current)
      : null;
  const changed = fresh
    ? Object.entries(fresh.documents)
        .filter(([, d]) => d.status !== "verified-current")
        .map(([k]) => rules.documents[k]?.title ?? k)
    : [];
  const note = !fresh
    ? `The current rule versions could not be checked${freshness.checkedAt ? ` (last check ${freshness.checkedAt.slice(0, 10)}, older than ${FRESHNESS_MAX_AGE_DAYS} days)` : ""}.`
    : fresh.staleRules.length
      ? `Changed since the rules were verified: ${changed.join(", ")}. Rules based on it are not used for a green result until re-verified.`
      : `The DSO ${freshness.source === "live" ? "reports right now" : `reported on ${freshness.checkedAt?.slice(0, 10)}`} exactly the versions the rules were verified against (verified ${Object.values(rules.documents)[0]?.verifiedOn}).${changed.length ? ` A draft changed: ${changed.join(", ")} (needs review; does not change today's rules).` : ""}`;

  const q = Object.fromEntries(Object.entries(ctx.quality).map(([k, v]) => [k, v.status]));

  return {
    gate: null,
    site: {
      plot,
      house,
      buildings,
      structures,
      publicAreas: ctx.publicAreas ? ctx.publicAreas.map((a) => L(a.outline)) : null,
      publicSides,
      front:
        f.method === "street-label"
          ? "street-label"
          : f.method === "longest-public"
            ? "estimated"
            : "none",
      access: { level, entries: localEntries, frontage, note: ctx.access.reason },
      streetTrees: (ctx.trees ?? []).map((t) => toLocal(f, t.at)),
      obstacles,
      exclusions,
      extensionEvidence,
      areaTable,
      freshness: { known: fresh !== null, staleRules: fresh?.staleRules ?? [], note },
      quality: q,
    },
  };
}
