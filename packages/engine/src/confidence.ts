/**
 * Confidence (ADR-028) and range evaluation (ADR-027).
 *
 * Confidence says how much to trust a result. It NEVER decides the verdict;
 * the verdict comes from rules evaluated over worst-case / best-case ranges.
 */
import type { Outcome } from "./facts.ts";

export type Confidence = "high" | "medium" | "low" | "unknown";

const ORDER: Confidence[] = ["unknown", "low", "medium", "high"];

/** Weakest link: a check is only as trustworthy as its least certain input. */
export function weakest(levels: Confidence[]): Confidence {
  if (levels.length === 0) return "unknown";
  return levels.reduce((min, l) => (ORDER.indexOf(l) < ORDER.indexOf(min) ? l : min));
}

/** What one source says about a fact. Shown as tick / cross / dash on the evidence board. */
export type Signal = "supports" | "contradicts" | "not-available";

export interface Evidence {
  source: string;
  signal: Signal;
  /** Proof-grade sources (a dated register change, a permit) vs hints (a roof shape). */
  strength: "proof" | "hint";
  note: string;
}

/**
 * Confidence of a fact from its evidence:
 *  - any proof that contradicts another proof → low (sources disagree)
 *  - supporting proof, nothing contradicting → high
 *  - only hints, all agreeing → medium; hints disagreeing → low
 *  - nothing available → unknown
 */
export function confidenceFrom(evidence: Evidence[]): Confidence {
  const avail = evidence.filter((e) => e.signal !== "not-available");
  if (avail.length === 0) return "unknown";
  const has = (signal: Signal, strength?: Evidence["strength"]) =>
    avail.some((e) => e.signal === signal && (strength === undefined || e.strength === strength));
  if (has("supports") && has("contradicts")) return "low";
  if (has("supports", "proof") || has("contradicts", "proof")) return "high";
  return "medium";
}

/** A numeric quantity that is only known within bounds, e.g. free area for a carport. */
export interface Range {
  worst: number;
  best: number;
}

export const exact = (v: number): Range => ({ worst: v, best: v });

/**
 * "Available must be at least needed", over a range.
 * pass: fits even in the worst case. fail: does not fit even in the best case.
 * unknown: fits only in some cases; the caller names the deciding fact.
 */
export function atLeast(available: Range, needed: number): Outcome {
  if (available.worst >= needed) return "pass";
  if (available.best < needed) return "fail";
  return "unknown";
}
