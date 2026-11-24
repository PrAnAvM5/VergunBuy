/**
 * Bruidsschat art. 22.36 under a: maximum total area of bijbehorende bouwwerken
 * in the bebouwingsgebied. Parameters come from the rule file, not from code.
 *
 * Bebouwingsgebied = back yard + ground under the main building, EXCEPT the
 * original main building. So every part of the house that is an extension:
 *   - adds its footprint to the bebouwingsgebied, and
 *   - counts as already-built area.
 * For parts whose status is unknown we evaluate both readings (ADR-027).
 */
import { atLeast, type Range } from "../confidence.ts";
import type { Outcome } from "../facts.ts";

export interface AreaTableParams {
  tier1UpToM2: number;
  tier1Share: number;
  tier2UpToM2: number;
  tier2BaseM2: number;
  tier2Share: number;
  tier3BaseM2: number;
  tier3Share: number;
  maxM2: number;
}

export function allowedArea(bebouwingsgebiedM2: number, p: AreaTableParams): number {
  const b = bebouwingsgebiedM2;
  let allowed: number;
  if (b <= p.tier1UpToM2) allowed = p.tier1Share * b;
  else if (b <= p.tier2UpToM2) allowed = p.tier2BaseM2 + p.tier2Share * (b - p.tier1UpToM2);
  else allowed = p.tier3BaseM2 + p.tier3Share * (b - p.tier2UpToM2);
  return Math.min(allowed, p.maxM2);
}

export interface HousePart {
  id: string;
  areaM2: number;
  status: "original" | "extension" | "unknown";
}

export interface AreaInput {
  /** Open back yard area, including existing outbuildings standing in it. */
  backYardM2: number;
  /** Footprint of existing outbuildings in the back yard (sheds, existing carports). */
  outbuildingsM2: number;
  houseParts: HousePart[];
  /** Footprint of what the user plans to add (one or more renovations). */
  plannedM2: number;
}

export interface AreaResult {
  outcome: Outcome;
  freeM2: Range;
  neededM2: number;
  /** Unknown house parts that decide the outcome, if it is "unknown". */
  deciding: string[];
}

function free(input: AreaInput, treatUnknownAs: "original" | "extension", p: AreaTableParams) {
  const ext = input.houseParts
    .filter(
      (h) => h.status === "extension" || (h.status === "unknown" && treatUnknownAs === "extension"),
    )
    .reduce((s, h) => s + h.areaM2, 0);
  const bebouwingsgebied = input.backYardM2 + ext;
  return allowedArea(bebouwingsgebied, p) - (input.outbuildingsM2 + ext);
}

export function checkAreaLimit(input: AreaInput, p: AreaTableParams): AreaResult {
  // Treating a part as an extension always leaves less (or equal) room, because the
  // area table never grants more than 100% of added ground. So "extension" = worst case.
  const worst = free(input, "extension", p);
  const best = free(input, "original", p);
  const freeM2 = { worst: round(worst), best: round(best) };
  const outcome = atLeast(freeM2, input.plannedM2);
  const deciding =
    outcome === "unknown"
      ? input.houseParts.filter((h) => h.status === "unknown").map((h) => h.id)
      : [];
  return { outcome, freeM2, neededM2: input.plannedM2, deciding };
}

const round = (n: number) => Math.round(n * 10) / 10;
