/**
 * Rule sets are versioned data, not code: rulesets/<municipality>/<activity>/<date>.json.
 * This schema is the contract; a rule file that does not match it fails CI.
 *
 * Every rule points at the exact document version it was verified against (a DSO expressionId)
 * and carries the verbatim legal text it is based on. A test checks that each quote really occurs
 * in the stored document text, so no rule can rest on an invented or misremembered sentence.
 */
import { z } from "zod";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A rule document the rule set relies on, pinned to the version that was read. */
const DocumentRef = z.object({
  title: z.string(),
  /** In-force version, or a draft (ontwerp) that was reviewed for coming changes. */
  status: z.enum(["in-force", "draft"]),
  /** DSO work id: names the document across all its versions. */
  workId: z.string().startsWith("/akn/"),
  /** DSO expression id of the version that was read. Another id at check time = changed. */
  verifiedExpressionId: z.string(),
  verifiedOn: Day,
  /** For drafts: the DSO's technical id of the draft decision (drafts are fetched by it). */
  technischId: z.string().optional(),
  /** Stored text of exactly that version, relative to the repository root. */
  textFile: z.string().optional(),
  url: z.string().url().optional(),
});

/** What happens to the verdict when a rule's condition is not met (or the rule applies). */
export const RuleEffect = z.enum([
  /** Bbl 2.25: if violated, a permit for the technical building activity is needed. */
  "technical-permit-condition",
  /** Omgevingsplan 22.27: all met → no permit needed for the omgevingsplanactiviteit. */
  "permit-free-condition",
  /** Omgevingsplan 22.36: all met → also in accordance with the omgevingsplan by law. */
  "in-accordance-condition",
  /** 22.28 / 22.38 / 22.39: if this applies, the named article does not apply. */
  "exclusion",
  /** Civil law: never changes the permit verdict, shown as advice. */
  "advice",
]);

/**
 * How the engine can evaluate the rule today:
 * - "check": an engine check with params;
 * - "by-design": always true for what the tool lets the user place (e.g. a carport on the ground);
 * - "needs-data": not yet checkable; until it is, the outcome for that path is "unknown".
 */
const Evaluation = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("check"),
    check: z.string(),
    params: z.record(z.union([z.number(), z.string(), z.boolean()])),
  }),
  z.object({ kind: z.literal("by-design"), why: z.string() }),
  z.object({ kind: z.literal("needs-data"), data: z.array(z.string()).min(1) }),
]);

const Rule = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  /** Plain-language explanation for the user. */
  plain: z.string(),
  effect: RuleEffect,
  /** For exclusions: which part they switch off. */
  excludes: z.enum(["22.27", "22.36", "22.27-and-22.36"]).optional(),
  /** Key into the rule set's documents. */
  document: z.string(),
  article: z.string(),
  /** The exact words of the article part, as in the stored text (verified by a test). */
  quote: z.string().min(10),
  evaluation: Evaluation,
});

const Definition = z.object({
  term: z.string(),
  document: z.string(),
  quote: z.string(),
});

const DraftReview = z.object({
  document: z.string(),
  reviewedOn: Day,
  finding: z.string(),
  stillToReview: z.array(z.string()),
});

export const RuleSet = z
  .object({
    schema: z.literal(2),
    municipality: z.string(),
    /** CBS/DSO code, e.g. gm0873. */
    municipalityCode: z.string().regex(/^gm\d{4}$/),
    /** Renovation type. New types get their own folder and file; the schema is shared. */
    activity: z.string().regex(/^[a-z-]+$/),
    version: Day,
    documents: z.record(DocumentRef),
    definitions: z.array(Definition),
    rules: z.array(Rule).min(1),
    drafts: z.array(DraftReview),
    /** Things the rule set knowingly does not decide yet, shown to the user. */
    openPoints: z.array(z.string()),
  })
  .superRefine((rs, ctx) => {
    const docs = new Set(Object.keys(rs.documents));
    const ids = new Set<string>();
    for (const [i, r] of rs.rules.entries()) {
      if (!docs.has(r.document))
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "document"],
          message: "unknown document",
        });
      if (ids.has(r.id))
        ctx.addIssue({ code: "custom", path: ["rules", i, "id"], message: "duplicate id" });
      ids.add(r.id);
      if ((r.effect === "exclusion") !== (r.excludes !== undefined))
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "excludes"],
          message: "exclusions (and only exclusions) name what they exclude",
        });
    }
    for (const [i, d] of rs.definitions.entries())
      if (!docs.has(d.document))
        ctx.addIssue({ code: "custom", path: ["definitions", i], message: "unknown document" });
  });

export type RuleSet = z.infer<typeof RuleSet>;
export type Rule = z.infer<typeof Rule>;

/** The current version of a document, as the DSO (live or the daily snapshot) reports it. */
export interface CurrentVersion {
  workId: string;
  expressionId: string | null;
}

export type DocumentFreshness =
  /** The DSO reports exactly the version the rules were verified against. */
  | "verified-current"
  /** The DSO reports another version: rules based on it are "changed since verified". */
  | "changed-since-verified"
  /** The DSO no longer lists the document at this location (for a draft: adopted or withdrawn). */
  | "not-listed"
  /** No current information (DSO and snapshot unavailable). */
  | "unknown";

export interface Freshness {
  documents: Record<string, { status: DocumentFreshness; current: string | null }>;
  /**
   * Rule ids whose in-force document is not verified-current. These can never produce a green
   * result. (A changed draft does not make rules stale; it means the draft needs a new review.)
   */
  staleRules: string[];
  /** True only when every document is verified-current. */
  allCurrent: boolean;
}

/**
 * Compares the versions a rule set was verified against with what the DSO reports now.
 * `current` is null when nothing is known (then everything is "unknown", never "current").
 */
export function ruleFreshness(
  rs: RuleSet,
  current: { inForce: CurrentVersion[]; drafts: CurrentVersion[] } | null,
): Freshness {
  const documents: Freshness["documents"] = {};
  for (const [key, doc] of Object.entries(rs.documents)) {
    if (!current) {
      documents[key] = { status: "unknown", current: null };
      continue;
    }
    const list = doc.status === "draft" ? current.drafts : current.inForce;
    const now =
      list.find((c) => c.workId === doc.workId && c.expressionId === doc.verifiedExpressionId) ??
      list.find((c) => c.workId === doc.workId);
    documents[key] = !now
      ? { status: "not-listed", current: null }
      : {
          status:
            now.expressionId === doc.verifiedExpressionId
              ? "verified-current"
              : "changed-since-verified",
          current: now.expressionId,
        };
  }
  const staleRules = rs.rules
    .filter(
      (r) =>
        rs.documents[r.document]?.status !== "draft" &&
        documents[r.document]?.status !== "verified-current",
    )
    .map((r) => r.id);
  return {
    documents,
    staleRules,
    allCurrent: Object.values(documents).every((d) => d.status === "verified-current"),
  };
}
