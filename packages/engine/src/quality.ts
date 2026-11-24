/**
 * Data quality and the zero-false-greens gate (ADR-018, ADR-030).
 *
 * Every data domain gets a status. A check may only PASS when every domain it depends on is
 * "complete". Anything less turns a pass into "unknown" (amber) and says why. Missing data can
 * therefore never produce a green result, wherever in the pipeline it went missing.
 *
 * Status meanings:
 *  - complete  all records were loaded and nothing had to be guessed
 *  - assumed   a value was estimated (e.g. the front side without a street label)
 *  - partial   some records were loaded, some are missing or the list was cut off
 *  - missing   the source could not be read at all
 *
 * Conservative assumptions that can only make results stricter (e.g. treating a narrow footpath
 * as public) are recorded as notes and do not lower the status.
 */
import type { Outcome } from "./facts.ts";

export type DataStatus = "complete" | "assumed" | "partial" | "missing";

export type Domain =
  "plot" | "buildings" | "heights" | "publicArea" | "vegetation" | "access" | "front";

export interface DomainQuality {
  status: DataStatus;
  /** Why the status is not complete. Shown to users when a check turns amber. */
  reasons: string[];
  /** Conservative assumptions and caveats that do not lower the status. */
  notes: string[];
}

export type DataQuality = Record<Domain, DomainQuality>;

const RANK: Record<DataStatus, number> = { complete: 0, assumed: 1, partial: 2, missing: 3 };

export const worstStatus = (a: DataStatus, b: DataStatus): DataStatus =>
  RANK[a] >= RANK[b] ? a : b;

/** A fresh quality record where every domain is complete until a step says otherwise. */
export function newQuality(): DataQuality {
  const q = () => ({
    status: "complete" as DataStatus,
    reasons: [] as string[],
    notes: [] as string[],
  });
  return {
    plot: q(),
    buildings: q(),
    heights: q(),
    publicArea: q(),
    vegetation: q(),
    access: q(),
    front: q(),
  };
}

/** Lower a domain's status (never raises it) and record why. */
export function downgrade(
  q: DataQuality,
  domain: Domain,
  status: DataStatus,
  reason: string,
): void {
  const d = q[domain];
  d.status = worstStatus(d.status, status);
  if (!d.reasons.includes(reason)) d.reasons.push(reason);
}

export function note(q: DataQuality, domain: Domain, text: string): void {
  if (!q[domain].notes.includes(text)) q[domain].notes.push(text);
}

export interface GatedOutcome {
  outcome: Outcome;
  /** Present when the outcome was limited by data quality. */
  reasons: string[];
}

/**
 * The gate. A pass survives only if every needed domain is complete; otherwise it becomes
 * unknown with the reasons. A fail stays a fail (it cannot create a false green), but carries
 * the reasons so the user knows it rests on incomplete data.
 */
export function gate(outcome: Outcome, needs: Domain[], q: DataQuality): GatedOutcome {
  const reasons = needs.flatMap((d) => (q[d].status === "complete" ? [] : q[d].reasons));
  if (outcome === "pass" && needs.some((d) => q[d].status !== "complete"))
    return { outcome: "unknown", reasons };
  return { outcome, reasons };
}
