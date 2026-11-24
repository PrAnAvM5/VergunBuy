/**
 * Interactive map: drag to pan, scroll or pinch to zoom, click to inspect.
 * Everything stays in the Dutch national grid (RD New, EPSG:28992), the same coordinates the
 * registers use, so overlays line up with the aerial photo without any reprojection.
 * Photo: PDOK aerial photo WMS (8 cm per pixel), requested as tiles for the visible area only.
 */
import type { PlotContext } from "@vergunbuy/data";
import { at, centroid, type Point, type Polygon as Ring } from "@vergunbuy/engine";
import OLMap from "ol/Map.js";
import View from "ol/View.js";
import Feature from "ol/Feature.js";
import { LineString, MultiPolygon, Point as OLPoint, Polygon } from "ol/geom.js";
import TileLayer from "ol/layer/Tile.js";
import VectorLayer from "ol/layer/Vector.js";
import TileWMS from "ol/source/TileWMS.js";
import VectorSource from "ol/source/Vector.js";
import { Projection } from "ol/proj.js";
import { defaults as defaultControls, ScaleLine } from "ol/control.js";
import { defaults as defaultInteractions } from "ol/interaction.js";
import { Circle, Fill, Stroke, Style, Text } from "ol/style.js";
import type { FeatureLike } from "ol/Feature.js";
import { EDGE_TEXT, isOtherHomeOnParcel } from "./format.ts";
import "ol/ol.css";

/** Overlay groups the user can switch on and off. */
export const OVERLAYS = [
  ["plot", "Plot and house"],
  ["buildings", "Other buildings"],
  ["parcels", "Parcel lines"],
  ["public", "Streets and green"],
  ["trees", "Trees and hedges"],
  ["obstacles", "Obstacles in the garden (height scan)"],
  ["access", "Car access"],
  ["edges", "Edge types"],
  ["labels", "House numbers and street names"],
] as const;
export type OverlayId = (typeof OVERLAYS)[number][0];

export interface MapHandle {
  setAerial(layerName: string): void;
  setOverlay(id: OverlayId, on: boolean): void;
  setSelected(key: string | undefined): void;
  dispose(): void;
}

const RD = new Projection({
  code: "EPSG:28992",
  units: "m",
  extent: [-285401.92, 22598.08, 595401.92, 903401.92],
});
const WMS = "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0";

const ring = (poly: Ring) => [[...poly, poly[0]!].map((p) => [p[0], p[1]])];

export function mountMap(
  el: HTMLElement,
  ctx: PlotContext,
  opts: {
    aerial: string;
    overlays: Record<OverlayId, boolean>;
    selected?: string;
    onSelect: (key: string | undefined) => void;
  },
): MapHandle {
  let photo = opts.aerial !== "";
  let selected = opts.selected;

  const aerial = new TileWMS({
    url: WMS,
    params: { LAYERS: opts.aerial || "Actueel_orthoHR", FORMAT: "image/jpeg", VERSION: "1.3.0" },
    projection: RD,
    crossOrigin: "anonymous",
    attributions: "Aerial photo: Beeldmateriaal Nederland via PDOK (CC BY 4.0)",
  });
  const photoLayer = new TileLayer({ source: aerial, visible: photo });

  // One vector layer per overlay group, so each can be switched independently.
  const groups = new Map<OverlayId, VectorSource>();
  const layers = new Map<OverlayId, VectorLayer>();
  const add = (group: OverlayId, f: Feature) => {
    let src = groups.get(group);
    if (!src) {
      src = new VectorSource();
      groups.set(group, src);
    }
    src.addFeature(f);
  };
  const poly = (r: Ring, props: Record<string, unknown>) =>
    new Feature({ geometry: new Polygon(ring(r)), ...props });
  const line = (a: Point, b: Point, props: Record<string, unknown>) =>
    new Feature({ geometry: new LineString([a, b]), ...props });
  const along = (edge: number, from: number, to: number): [Point, Point] => {
    const a = at(ctx.plot.outline, edge);
    const b = at(ctx.plot.outline, edge + 1);
    const p = (t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    return [p(from), p(to)];
  };

  for (const p of ctx.nearbyParcels) add("parcels", poly(p.outline, { kind: "parcel" }));
  for (const a of ctx.publicAreas ?? []) {
    const isExit = ctx.exits.some((e) => e.id === a.id);
    add(
      isExit ? "access" : "public",
      poly(a.outline, {
        kind: isExit ? "exit" : `public-${a.kind}`,
        sel: `${isExit ? "exit" : "public"}:${a.id}`,
      }),
    );
  }
  // Obstacles: every 0.5 m cell as a square, one feature per obstacle so a click opens it.
  for (const o of ctx.obstacles?.obstacles ?? []) {
    const half = (ctx.obstacles?.res ?? 0.5) / 2;
    const squares = o.cells.map(([x, y]) => [
      [
        [x - half, y - half],
        [x + half, y - half],
        [x + half, y + half],
        [x - half, y + half],
        [x - half, y - half],
      ],
    ]);
    add(
      "obstacles",
      new Feature({
        geometry: new MultiPolygon(squares),
        kind: o.kind === "tall" ? "obstacle-tall" : "obstacle-medium",
        sel: `obstacle:${o.id}`,
      }),
    );
  }
  for (const s of ctx.structures)
    add("obstacles", poly(s.outline, { kind: "structure", sel: `structure:${s.id}` }));
  for (const h of ctx.hedges)
    add("trees", poly(h.outline, { kind: "hedge", sel: `hedge:${h.id}` }));
  for (const t of ctx.trees ?? [])
    add(
      "trees",
      new Feature({
        geometry: new OLPoint(t.at),
        kind: "tree",
        crown: t.crownM,
        sel: `tree:${t.id}`,
      }),
    );
  for (const b of ctx.neighbours)
    if (!isOtherHomeOnParcel(b))
      add("buildings", poly(b.outline, { kind: "neighbour", sel: `neighbour:${b.id}` }));
  add("plot", poly(ctx.plot.outline, { kind: "plot", sel: "plot:main" }));
  // Other homes on this parcel go above the plot fill, or the fill would hide them.
  for (const b of ctx.neighbours)
    if (isOtherHomeOnParcel(b))
      add("plot", poly(b.outline, { kind: "other-home", sel: `neighbour:${b.id}` }));
  for (const b of ctx.outbuildings)
    add("plot", poly(b.outline, { kind: "outbuilding", sel: `outbuilding:${b.id}` }));
  for (const b of ctx.house) add("plot", poly(b.outline, { kind: "house", sel: `house:${b.id}` }));
  ctx.edges.forEach((r, i) => {
    const [a, b] = along(r.edge, r.from, r.to);
    add("edges", line(a, b, { kind: "edge", edgeKind: r.kind, sel: `edge:${i}` }));
  });
  for (const e of [...ctx.carReachableEdges, ...ctx.pavementRuns]) {
    const [a, b] = along(e.edge, e.from, e.to);
    add("access", line(a, b, { kind: "car-edge" }));
  }
  // Labels: house numbers on every building that has them, street names from the map register.
  for (const b of [...ctx.house, ...ctx.outbuildings, ...ctx.neighbours])
    if (b.addressLabels?.length)
      add(
        "labels",
        new Feature({
          geometry: new OLPoint(centroid(b.outline)),
          kind: "numbers",
          text: compactNumbers(b.addressLabels),
          own: ctx.house.includes(b),
        }),
      );
  for (const l of ctx.streetNames)
    add("labels", new Feature({ geometry: new OLPoint(l.at), kind: "street", text: l.name }));

  const style = (f: FeatureLike, resolution: number): Style | Style[] | undefined => {
    const kind = f.get("kind") as string;
    const isSel = selected !== undefined && f.get("sel") === selected;
    const s = styleFor(kind, f, resolution, photo);
    if (!isSel || !s) return s;
    return [
      ...(Array.isArray(s) ? s : [s]),
      new Style({ stroke: new Stroke({ color: "#ff2d55", width: 3 }) }),
    ];
  };
  // Draw order: parcels, public, buildings, trees, plot, edges, access, labels. Car access goes
  // above the edge types so the "car can reach here" marking is never broken up by them.
  const order: OverlayId[] = [
    "parcels",
    "public",
    "buildings",
    "trees",
    "plot",
    "obstacles",
    "edges",
    "access",
    "labels",
  ];
  order.forEach((id, z) => {
    const source = groups.get(id) ?? new VectorSource();
    const layer = new VectorLayer({
      source,
      style,
      zIndex: z + 1,
      visible: opts.overlays[id],
      declutter: id === "labels",
    });
    layers.set(id, layer);
  });

  const xs = ctx.plot.outline.map((p) => p[0]);
  const ys = ctx.plot.outline.map((p) => p[1]);
  // Open on the plot with some street and neighbours around it.
  const extent = [
    Math.min(...xs) - 8,
    Math.min(...ys) - 8,
    Math.max(...xs) + 8,
    Math.max(...ys) + 8,
  ];
  const view = new View({
    projection: RD,
    center: [(extent[0]! + extent[2]!) / 2, (extent[1]! + extent[3]!) / 2],
    resolution: 0.1,
    minResolution: 0.02,
    maxResolution: 4,
    enableRotation: false,
    constrainResolution: false,
  });
  el.innerHTML = "";
  el.classList.add("olmap");
  const map = new OLMap({
    target: el,
    view,
    layers: [photoLayer, ...order.map((id) => layers.get(id)!)],
    controls: defaultControls({ rotate: false, attributionOptions: { collapsible: false } }).extend(
      [new ScaleLine({ units: "metric" })],
    ),
    interactions: defaultInteractions({ altShiftDragRotate: false, pinchRotate: false }),
  });
  el.style.background = photo ? "#2b2b2b" : "#fbfaf7";
  view.fit(extent, { padding: [20, 20, 20, 20] });
  // Never zoom in so far on a small plot that the photo is only stretched.
  if ((view.getResolution() ?? 1) < 0.06) view.setResolution(0.06);

  map.on("singleclick", (e) => {
    let key: string | undefined;
    map.forEachFeatureAtPixel(
      e.pixel,
      (f) => {
        const s = f.get("sel") as string | undefined;
        if (s && f.get("kind") !== "parcel") {
          key = s;
          return true;
        }
        return false;
      },
      { hitTolerance: 4 },
    );
    selected = key;
    for (const l of layers.values()) l.changed();
    opts.onSelect(key);
  });
  map.on("pointermove", (e) => {
    if (e.dragging) return;
    const hit = map.hasFeatureAtPixel(e.pixel, {
      layerFilter: (l) => l !== layers.get("parcels") && l !== layers.get("labels"),
      hitTolerance: 4,
    });
    map.getTargetElement().style.cursor = hit ? "pointer" : "";
  });

  return {
    setAerial(name) {
      photo = name !== "";
      if (photo) aerial.updateParams({ LAYERS: name });
      photoLayer.setVisible(photo);
      el.style.background = photo ? "#2b2b2b" : "#fbfaf7";
      for (const l of layers.values()) l.changed();
    },
    setOverlay(id, on) {
      layers.get(id)?.setVisible(on);
    },
    setSelected(key) {
      selected = key;
      for (const l of layers.values()) l.changed();
    },
    dispose() {
      map.setTarget(undefined);
      map.dispose();
      el.classList.remove("olmap");
      el.style.background = "";
      el.innerHTML = "";
    },
  };
}

/** "10, 10a, 10b" stays readable; long lists of flats become "2–48 (24)". */
function compactNumbers(labels: string[]): string {
  if (labels.length <= 3) return labels.join(", ");
  return `${labels[0]}–${labels[labels.length - 1]} (${labels.length})`;
}

const PUBLIC_FILL: Record<string, string> = {
  "public-road": "#e3ded3",
  "public-footpath": "#efebe2",
  "public-square": "#efebe2",
  "public-green": "#cfe5bf",
  "public-water": "#b9d8f0",
  "public-rear-path": "#efebe2",
};

function styleFor(
  kind: string,
  f: FeatureLike,
  resolution: number,
  photo: boolean,
): Style | Style[] | undefined {
  const stroke = (color: string, width: number, lineDash?: number[]) =>
    new Stroke({ color, width, ...(lineDash ? { lineDash } : {}) });
  const fill = (color: string) => new Fill({ color });
  switch (kind) {
    case "parcel":
      return new Style({
        stroke: stroke(photo ? "rgba(255,255,255,0.45)" : "#d8d4ca", 1),
      });
    case "plot":
      return new Style({
        stroke: stroke(photo ? "#ffffff" : "#1d1f24", photo ? 3 : 2),
        fill: fill(photo ? "rgba(255,255,255,0.01)" : "#ffffff"),
      });
    case "house":
      return new Style({
        stroke: stroke(photo ? "#c9c0ff" : "#4a3db0", 2.5),
        fill: fill(photo ? "rgba(122,108,230,0.18)" : "rgba(122,108,230,0.85)"),
      });
    case "outbuilding":
      return new Style({
        stroke: stroke(photo ? "#e3dcff" : "#6b5bd2", 2),
        fill: fill(photo ? "rgba(185,174,232,0.15)" : "#b9aee8"),
      });
    case "other-home":
      return new Style({
        stroke: stroke(photo ? "#7fe0d4" : "#1f7a6f", 2.5, [6, 4]),
        fill: fill(photo ? "rgba(42,157,143,0.15)" : "rgba(42,157,143,0.45)"),
      });
    case "neighbour":
      return new Style({
        stroke: stroke(photo ? "rgba(255,255,255,0.7)" : "#857f73", 1),
        fill: fill(photo ? "rgba(255,255,255,0.01)" : "#a8a296"),
      });
    case "exit":
      return new Style({
        stroke: stroke("#f2b134", 2.5),
        fill: fill(photo ? "rgba(242,177,52,0.25)" : "rgba(242,177,52,0.85)"),
      });
    case "car-edge":
      // Dashed = possible, not proven. A registered crossing is the solid "exit" shape.
      return [
        new Style({ stroke: stroke("rgba(0,0,0,0.35)", 9) }),
        new Style({ stroke: stroke("#f2b134", 6, [14, 8]) }),
      ];
    case "edge": {
      const e = EDGE_TEXT[f.get("edgeKind") as string];
      return new Style({
        stroke: stroke(e?.color ?? "#000", 4, e?.dash ? e.dash.split(" ").map(Number) : undefined),
      });
    }
    case "obstacle-tall":
      return new Style({ fill: fill(photo ? "rgba(235,50,50,0.45)" : "rgba(214,60,60,0.55)") });
    case "obstacle-medium":
      return new Style({ fill: fill(photo ? "rgba(255,200,0,0.45)" : "rgba(230,170,20,0.5)") });
    case "structure":
      return new Style({ stroke: stroke("#00b8d9", 2.5), fill: fill("rgba(0,184,217,0.15)") });
    case "hedge":
      return new Style({
        stroke: stroke(photo ? "#9be07f" : "#2f5d22", 1.5),
        fill: fill(photo ? "rgba(79,138,60,0.01)" : "rgba(79,138,60,0.7)"),
      });
    case "tree": {
      const r = Math.max(3, (Number(f.get("crown")) || 4) / 2 / resolution);
      return new Style({
        image: new Circle({
          radius: r,
          stroke: stroke(photo ? "#9be07f" : "#1f5e1c", 1.5, [4, 3]),
          fill: fill(photo ? "rgba(63,143,58,0.01)" : "rgba(63,143,58,0.45)"),
        }),
      });
    }
    case "numbers":
      if (resolution > 0.35) return undefined; // too far out: numbers would only clutter
      return new Style({
        text: new Text({
          text: String(f.get("text")),
          font: `${f.get("own") ? "700" : "600"} 12px system-ui, sans-serif`,
          fill: fill(f.get("own") ? "#ffffff" : "#1d1f24"),
          stroke: new Stroke({
            color: f.get("own") ? "#4a3db0" : "rgba(255,255,255,0.9)",
            width: 4,
          }),
          overflow: true,
        }),
      });
    case "street":
      return new Style({
        text: new Text({
          text: String(f.get("text")),
          font: "600 13px system-ui, sans-serif",
          fill: fill(photo ? "#ffffff" : "#5a5e66"),
          stroke: new Stroke({ color: photo ? "rgba(0,0,0,0.6)" : "#fbfaf7", width: 3 }),
        }),
      });
    default:
      if (kind.startsWith("public-"))
        return new Style({
          stroke: stroke(photo ? "rgba(255,255,255,0.3)" : "#d6d0c2", 0.8),
          fill: fill(photo ? "rgba(255,255,255,0.01)" : (PUBLIC_FILL[kind] ?? "#efebe2")),
        });
      return undefined;
  }
}
