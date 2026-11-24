/**
 * Rule sets are versioned data, not code (rulesets/<municipality>/<date>.json).
 * This schema is the contract: a rule file that does not match it fails CI.
 */
import { z } from "zod";

const SourceRef = z.object({
  document: z.string(),
  article: z.string(),
  version: z.string(),
  url: z.string().url(),
});

const Rule = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  /** "public-law" decides the verdict; "civil-law" is advisory only (ADR-022). */
  layer: z.enum(["public-law", "civil-law"]),
  /** Engine check that evaluates this rule. */
  check: z.string(),
  params: z.record(z.union([z.number(), z.string(), z.boolean()])),
  source: SourceRef,
});

export const RuleSet = z.object({
  municipality: z.string(),
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  activity: z.literal("carport"),
  sourcesCheckedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rules: z.array(Rule).min(1),
});

export type RuleSet = z.infer<typeof RuleSet>;
export type Rule = z.infer<typeof Rule>;
