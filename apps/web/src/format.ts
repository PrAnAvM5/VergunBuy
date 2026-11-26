/** Escape text for safe insertion into HTML. All data shown in the UI goes through this. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A building on this parcel that holds homes but is not this house (see SHARED_PLOT). */
export const isOtherHomeOnParcel = (b: {
  onPlotShare?: number;
  addresses?: number;
  use?: string;
}) => (b.onPlotShare ?? 0) >= 0.5 && (b.addresses ?? 0) > 0 && /woon/i.test(b.use ?? "");

/** Colour of one obstacle cell by its own height; overhang has its own colour. */
export const HEIGHT_BANDS: { minM: number; color: string; label: string }[] = [
  { minM: 2.5, color: "#d63c3c", label: "2.5 m and higher" },
  { minM: 1.5, color: "#e8961e", label: "1.5 – 2.5 m" },
  { minM: 1.0, color: "#f0d04a", label: "1.0 – 1.5 m" },
];
export const OVERHANG_COLOR = "#8a7fd6";
export const bandOf = (h: number) => HEIGHT_BANDS.find((b) => h >= b.minM) ?? HEIGHT_BANDS[2]!;

export const OBSTACLE_KIND_TEXT: Record<string, string> = {
  tall: "Tall: tree or high structure on the plot",
  medium: "Medium: hedge, shrub, low structure, or something movable",
  overhang: "Branches hanging over from a tree next door",
  boundary: "Tree on the boundary line (may stand on either side)",
};

export const m = (n: number, digits = 1) => `${n.toFixed(digits)} m`;
export const m2 = (n: number) => `${Math.round(n)} m²`;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  html = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.innerHTML = html;
  return node;
}

/** Plain-language explanation of each flag, for the customer view. */
export const FLAG_TEXT: Record<string, string> = {
  MULTIPLE_HOUSE_BUILDINGS:
    "More than one building outline belongs to this address. We use the largest as the house.",
  HOUSE_NOT_ON_PLOT:
    "The house outline lies mostly outside the plot we found. The plot may be split or merged in the cadastre.",
  PUBLIC_AREA_UNKNOWN:
    "Streets and public areas could not be loaded, so edges toward them are marked unknown.",
  POSSIBLE_ACHTERPAD:
    "A narrow footpath that does not run along a road borders the plot. We treat it as public (the safe choice). If it is a rear path that only serves the gardens, more positions may be allowed.",
  WATER_NEARBY:
    "Water borders the plot. Whether it counts as public area is not known from the data.",
  NEIGHBOURS_UNKNOWN:
    "Buildings could not be loaded, so shared walls with neighbours could not be detected.",
  OUTBUILDINGS_ON_PLOT:
    "There is another registered building on this plot, such as a garage or shed. It counts toward the built area.",
  HEIGHTS_MISSING: "Building heights could not be loaded, so heights are unknown.",
  HEIGHTS_PARTIAL:
    "Some buildings on this plot have no measured height. Small sheds and recent builds are often missing from the height scan.",
  CHANGED_BETWEEN_SCANS:
    "The national height scans show the house changed between two scans. This can mean an extension or a new roof, which matters for how much more may be built.",
  NO_EXIT_FOUND:
    "No registered driveway crossing and no road along the plot. Registers often miss exits, especially rural and rear ones, so check the aerial photo. A new exit needs its own permit.",
  PAVEMENT_CROSSING:
    "The road lies just beyond a pavement or verge, the usual way Dutch homes are reached, but no driveway crossing is registered there. Check the aerial photo; a new crossing needs its own permit.",
  MULTI_UNIT_BUILDING:
    "This address is one unit in a building with several addresses (flats, or homes above a shop). The building and plot are shared, so a carport needs the other owners to agree, usually through the owners' association (VvE).",
  SHARED_PLOT:
    "This parcel also holds other homes, as with housing-association terraces or flats. Plot size, garden and setbacks are for the whole parcel, not just this home, and the owner of the parcel would have to agree to any build.",
  POSSIBLE_EXIT:
    "A road or parking area runs directly along the plot, so a car can reach it, but no driveway crossing is registered there. Check the aerial photo.",
  BUILDING_ON_BOUNDARY:
    "A building crosses the plot boundary, so it is unclear which plot it belongs to. Cadastral boundaries are indicative.",
  TREES_UNKNOWN: "Registered trees could not be loaded.",
  DATA_TRUNCATED:
    "Not all records could be read for this area. Checks that depend on them show as 'needs a check'.",
  FRONT_ESTIMATED:
    "The front of the plot is estimated (the street name was not found next to it). On corner and rural plots this can be the wrong side.",
  INVALID_GEOMETRY:
    "Some shapes from the registers are not clean (for example, edges crossing each other). Measurements on them may be off.",
  PLOT_AREA_MISMATCH:
    "The drawn plot differs from the registered plot area by more than 5%. Boundaries may be inaccurate.",
};

export const HOUSE_TYPE_TEXT: Record<string, string> = {
  detached: "Detached house",
  "semi-or-end": "Semi-detached or end of terrace",
  terraced: "Terraced house",
  corner: "Corner house",
  unit: "Flat or unit in a shared building",
};

export const EDGE_TEXT: Record<string, { label: string; color: string; dash?: string }> = {
  public: { label: "Public area (street, path, green)", color: "#2f6fbf" },
  water: { label: "Water", color: "#2aa3c9" },
  "rear-path": { label: "Rear path", color: "#b07a1a", dash: "6 4" },
  "shared-wall": { label: "Shared wall", color: "#8c5a3c" },
  neighbour: { label: "Neighbouring plot", color: "#8a8e96" },
  unknown: { label: "Unknown (data missing)", color: "#b23a3a", dash: "2 4" },
};

export const STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  complete: { label: "Complete", cls: "ok" },
  assumed: { label: "Estimated", cls: "warn" },
  partial: { label: "Incomplete", cls: "warn" },
  missing: { label: "Missing", cls: "bad" },
};

export const DOMAIN_TEXT: Record<string, string> = {
  plot: "Plot outline",
  buildings: "Buildings",
  heights: "Heights",
  publicArea: "Streets and public area",
  vegetation: "Trees and plants",
  access: "Car access",
  front: "Front of the plot",
  obstacles: "Obstacles in the garden",
  boundary: "Plot line and what things are made of",
  legal: "Zoning plans and monuments",
};

/** Data completeness card: what we know fully, what is estimated, incomplete or missing. */
export function qualityCard(
  q: Record<string, { status: string; reasons: string[]; notes: string[] }>,
): string {
  const rows = Object.entries(q)
    .map(([d, v]) => {
      const st = STATUS_TEXT[v.status] ?? { label: v.status, cls: "grey" };
      const why = [...v.reasons, ...v.notes]
        .map((r) => `<div class="small muted">${esc(r)}</div>`)
        .join("");
      return `<div class="qrow"><div><div>${esc(DOMAIN_TEXT[d] ?? d)}</div>${why}</div><span class="pill ${st.cls}">${esc(st.label)}</span></div>`;
    })
    .join("");
  return `<h3>Data completeness</h3><p class="small muted" style="margin:0 0 6px">A check can only be green when all the data it needs is complete.</p>${rows}`;
}

export const ACCESS_TEXT: Record<string, { label: string; cls: string }> = {
  registered: { label: "Registered driveway", cls: "ok" },
  possible: { label: "Possible, needs a check", cls: "warn" },
  "none-found": { label: "Not found, needs a check", cls: "warn" },
  unknown: { label: "Unknown", cls: "bad" },
};
