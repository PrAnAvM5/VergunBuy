/**
 * Concept: can a car get onto the plot? (carport precondition)
 *
 * Evidence ladder:
 *  1. registered  a registered driveway crossing (BGT wegdeel "inrit") touches the plot → pass
 *  2. possible    a plot edge lies directly on a carriageway, parking area or shared yard,
 *                 so a car can physically reach the boundary, but no crossing is registered → unknown
 *  3. none-found  no registered crossing and no car-usable surface along the plot → unknown
 *                 (registers are incomplete: rural and rear exits are often not recorded)
 *  4. unknown     public-area data is missing → unknown
 *
 * Access is never "fail" from data alone: a missing record is not proof that there is no exit.
 */
import type { Outcome } from "../facts.ts";

export type AccessLevel = "registered" | "possible" | "none-found" | "unknown";

/** BGT road functions a car can drive on up to the plot boundary. */
export const CAR_SURFACES = ["rijbaan", "parkeervlak", "inrit", "erf", "woonerf", "parkeerplaats"];

export const isCarSurface = (functie: string | undefined) =>
  !!functie &&
  CAR_SURFACES.some((s) => functie.toLowerCase().includes(s)) &&
  !/voet|fiets|ruiter/i.test(functie);

export interface AccessInput {
  publicDataAvailable: boolean;
  registeredExits: number;
  /** Length of each stretch of plot boundary lying directly on a car-usable surface. */
  carReachableRunsM: number[];
}

export interface AccessResult {
  level: AccessLevel;
  outcome: Outcome;
  reason: string;
}

/** Minimum stretch of boundary a car needs (about a car's width plus margin). */
export const MIN_ACCESS_WIDTH_M = 2.5;

export function assessAccess(input: AccessInput): AccessResult {
  if (!input.publicDataAvailable)
    return {
      level: "unknown",
      outcome: "unknown",
      reason: "Street data could not be loaded, so car access is unknown.",
    };
  if (input.registeredExits > 0)
    return {
      level: "registered",
      outcome: "pass",
      reason: `${input.registeredExits} registered driveway crossing${input.registeredExits > 1 ? "s" : ""} touch${input.registeredExits > 1 ? "" : "es"} the plot.`,
    };
  const wide = input.carReachableRunsM.filter((m) => m >= MIN_ACCESS_WIDTH_M);
  if (wide.length > 0)
    return {
      level: "possible",
      outcome: "unknown",
      reason: `A car can reach the plot boundary over ${Math.max(...wide).toFixed(1)} m, but no driveway crossing is registered there. Check the aerial photo; a new exit needs its own permit.`,
    };
  return {
    level: "none-found",
    outcome: "unknown",
    reason:
      "No registered driveway crossing and no road or parking area directly along the plot. Registers often miss exits (especially rural and rear ones), so check the aerial photo.",
  };
}
