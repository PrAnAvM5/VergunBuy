/** Escape text for safe insertion into HTML. All data shown in the UI goes through this. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
    "There are narrow footpaths nearby. We treat them as public (the safe choice). If one is a rear path that only serves the gardens, more positions may be allowed.",
  WATER_NEARBY:
    "Water borders the plot. Whether it counts as public area is not known from the data.",
  NEIGHBOURS_UNKNOWN:
    "Buildings could not be loaded, so shared walls with neighbours could not be detected.",
  OUTBUILDINGS_ON_PLOT:
    "There is another registered building on this plot, such as a garage or shed. It counts toward the built area.",
};

export const HOUSE_TYPE_TEXT: Record<string, string> = {
  detached: "Detached house",
  "semi-or-end": "Semi-detached or end of terrace",
  terraced: "Terraced house",
  corner: "Corner house",
};

export const EDGE_TEXT: Record<string, { label: string; color: string; dash?: string }> = {
  public: { label: "Public area (street, path, green)", color: "#2f6fbf" },
  water: { label: "Water", color: "#2aa3c9" },
  "rear-path": { label: "Rear path", color: "#b07a1a", dash: "6 4" },
  "shared-wall": { label: "Shared wall", color: "#d0582b" },
  neighbour: { label: "Neighbouring plot", color: "#8a8e96" },
  unknown: { label: "Unknown (data missing)", color: "#b23a3a", dash: "2 4" },
};
