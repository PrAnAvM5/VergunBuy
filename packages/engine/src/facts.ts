/**
 * Facts: every value the engine knows, with how sure we are of it and where it came from.
 *
 * Certainty labels (ADR-019):
 *  - measured      taken directly from an authoritative dataset (BAG, BRK, BGT, 3D BAG)
 *  - derived       computed by the engine from other facts (e.g. back yard from the 1 m line)
 *  - assumed       a documented default we apply when data is silent (always carries a flag)
 *  - user-answered the user told us (only when data cannot answer, ADR-020)
 *  - unknown       we could not establish it; any check that needs it returns "unknown"
 */
export type Certainty = "measured" | "derived" | "assumed" | "user-answered" | "unknown";

export interface SourceRef {
  /** Dataset or rule source, e.g. "BAG pand", "Bruidsschat art. 22.27". */
  name: string;
  /** Object id or article within the source, when there is one. */
  ref?: string;
}

export interface Fact<T> {
  value: T;
  certainty: Certainty;
  /** Pipeline step that produced this fact, e.g. "classify-edges". Links to the trace. */
  step: string;
  /** Ids of the facts this one was derived from. Empty for measured facts. */
  inputs: string[];
  sources: SourceRef[];
  /** One plain-language sentence explaining the value. Shown in the Inspector. */
  note: string;
}

type FactMeta = Omit<Fact<unknown>, "value" | "certainty">;

export const measured = <T>(value: T, meta: Omit<FactMeta, "inputs">): Fact<T> => ({
  value,
  certainty: "measured",
  inputs: [],
  ...meta,
});

export const derived = <T>(value: T, meta: FactMeta): Fact<T> => ({
  value,
  certainty: "derived",
  ...meta,
});

export const assumed = <T>(value: T, meta: FactMeta): Fact<T> => ({
  value,
  certainty: "assumed",
  ...meta,
});

export const unknownFact = <T>(meta: FactMeta): Fact<T | null> => ({
  value: null,
  certainty: "unknown",
  ...meta,
});

/** Check outcome (ADR-018). "unknown" must never be shown as green. */
export type Outcome = "pass" | "fail" | "unknown";

/**
 * Combine check outcomes for one carport position.
 * fail beats unknown beats pass, so missing data can never produce a green result.
 */
export function combineOutcomes(outcomes: Outcome[]): Outcome {
  if (outcomes.includes("fail")) return "fail";
  if (outcomes.includes("unknown")) return "unknown";
  return "pass";
}
