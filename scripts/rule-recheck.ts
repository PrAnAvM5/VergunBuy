/**
 * Rule re-check (run daily by dso-daily.yml, after the snapshot).
 *
 * For every rule set, compares the document versions its rules were verified against with the
 * versions in today's DSO snapshot. For each document that changed, downloads the new text and
 * checks every quoted sentence: still there word for word, or gone/changed. The result is added
 * to the rule-change issue, so the person re-verifying sees exactly which rules to re-read.
 *
 * It never edits a rule: a changed document keeps its rules "changed since verified" (never
 * green) until a person updates the rule set and its version ids.
 */
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RuleSet } from "../packages/engine/src/ruleset.ts";

const BASE =
  "https://service.omgevingswet.overheid.nl/publiek/omgevingsdocumenten/api/presenteren/v8";
const key = process.env.DSO_API_KEY;
const out = process.env.CHANGES_OUT;
const snapshot = JSON.parse(readFileSync("apps/web/public/rules/dso-snapshot.json", "utf8")) as {
  points: { documents: { workId: string; expressionId: string | null }[] }[];
};
const current = new Map<string, Set<string>>();
for (const p of snapshot.points)
  for (const d of p.documents)
    current.set(d.workId, (current.get(d.workId) ?? new Set()).add(String(d.expressionId)));

const normalize = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();

async function currentText(workId: string): Promise<string | null> {
  if (!key) return null;
  const res = await fetch(`${BASE}/regelingen/${workId.replace(/\//g, "_")}/documentstructuur`, {
    headers: { "x-api-key": key, accept: "application/hal+json, application/json" },
    signal: AbortSignal.timeout(120_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const parts: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) if (k !== "_links") walk(x);
  };
  walk(await res.json());
  return normalize(parts.join(" "));
}

const lines: string[] = [];
for (const m of readdirSync("rulesets"))
  for (const activity of readdirSync(join("rulesets", m)))
    for (const f of readdirSync(join("rulesets", m, activity))) {
      const rs = RuleSet.parse(JSON.parse(readFileSync(join("rulesets", m, activity, f), "utf8")));
      for (const [docKey, doc] of Object.entries(rs.documents)) {
        if (doc.status !== "in-force") continue;
        const now = current.get(doc.workId);
        if (!now) {
          lines.push(`- ${m}/${activity}: **${doc.title}** is not in today's snapshot.`);
          continue;
        }
        if (now.has(doc.verifiedExpressionId)) continue;
        const rules = rs.rules.filter((r) => r.document === docKey);
        lines.push(
          `- ${m}/${activity}: **${doc.title}** changed (verified ${doc.verifiedExpressionId}, now ${[...now].join(", ")}). ${rules.length} rule(s) are "changed since verified".`,
        );
        const text = await currentText(doc.workId);
        if (text === null) {
          lines.push("  - The new text could not be downloaded; re-read all these rules.");
          continue;
        }
        for (const r of rules)
          lines.push(
            `  - ${text.includes(normalize(r.quote)) ? "quote still present" : "**quote changed or gone**"}: ${r.id} (${r.article})`,
          );
      }
    }

console.log(lines.join("\n") || "All rule sets match today's DSO versions.");
if (lines.length && out) appendFileSync(out, `\n\n## Rule sets affected\n\n${lines.join("\n")}\n`);
