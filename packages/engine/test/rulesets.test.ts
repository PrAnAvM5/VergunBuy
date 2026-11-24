import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { RuleSet, ruleFreshness } from "../src/index.ts";

const repo = join(import.meta.dirname, "../../..");
const root = join(repo, "rulesets");

/** All text in a stored DSO document structure, with markup and invisible characters removed. */
function documentText(file: string): { text: string; links: string } {
  const body = JSON.parse(gunzipSync(readFileSync(join(repo, file))).toString("utf8")) as {
    _links?: unknown;
  };
  const parts: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) if (k !== "_links") walk(x);
  };
  walk(body);
  return { text: normalize(parts.join(" ")), links: JSON.stringify(body._links ?? {}) };
}

function normalize(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The expression id as it appears in a DSO link path, e.g. ..._nld_2026_06_11_12190506. */
const asPath = (expressionId: string) => expressionId.replace(/[/@;.-]/g, "_");

const files: string[] = [];
for (const m of readdirSync(root))
  for (const activity of readdirSync(join(root, m)))
    for (const f of readdirSync(join(root, m, activity))) files.push(join(m, activity, f));

describe.each(files)("rule set %s", (file) => {
  const json: unknown = JSON.parse(readFileSync(join(root, file), "utf8"));
  const parsed = RuleSet.safeParse(json);

  it("matches the schema and its file name", () => {
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(file.endsWith(`${parsed.data!.activity}/${parsed.data!.version}.json`)).toBe(true);
  });

  const rs = parsed.data!;
  for (const [key, doc] of Object.entries(rs.documents)) {
    if (!doc.textFile) continue;
    it(`${key}: stored text is the verified version, and every quote occurs in it verbatim`, () => {
      expect(existsSync(join(repo, doc.textFile!))).toBe(true);
      const { text, links } = documentText(doc.textFile!);
      // The stored text's own links name the version (drafts: the draft decision) it came from.
      expect(links).toContain(
        doc.technischId ?? asPath(doc.verifiedExpressionId.split("/").pop()!),
      );
      const quotes = [
        ...rs.rules.filter((r) => r.document === key).map((r) => [r.id, r.quote]),
        ...rs.definitions.filter((d) => d.document === key).map((d) => [d.term, d.quote]),
      ];
      const missing = quotes.filter(([, q]) => !text.includes(normalize(q!))).map(([id]) => id);
      expect(missing).toEqual([]);
    });
  }
});

describe("rule freshness (changed since verified → never green)", () => {
  const rs = RuleSet.parse(
    JSON.parse(readFileSync(join(root, "woensdrecht/carport/2026-11-24.json"), "utf8")),
  );
  const inForce = Object.values(rs.documents)
    .filter((d) => d.status === "in-force")
    .map((d) => ({ workId: d.workId, expressionId: d.verifiedExpressionId }));
  const drafts = Object.values(rs.documents)
    .filter((d) => d.status === "draft")
    .map((d) => ({ workId: d.workId, expressionId: d.verifiedExpressionId }));

  it("is current when the DSO reports exactly the verified versions", () => {
    const f = ruleFreshness(rs, { inForce, drafts });
    expect(f.allCurrent).toBe(true);
    expect(f.staleRules).toEqual([]);
  });

  it("marks every rule of a changed document stale", () => {
    const changed = inForce.map((d) =>
      d.workId.includes("omgevingsplan") ? { ...d, expressionId: `${d.expressionId}x` } : d,
    );
    const f = ruleFreshness(rs, { inForce: changed, drafts });
    expect(f.documents.omgevingsplan!.status).toBe("changed-since-verified");
    expect(f.staleRules).toContain("pf-back-yard");
    expect(f.staleRules).not.toContain("tech-max-5m");
    expect(f.allCurrent).toBe(false);
  });

  it("knows nothing without DSO information, and a new draft needs review but does not stale rules", () => {
    expect(ruleFreshness(rs, null).staleRules).toHaveLength(rs.rules.length);
    const f = ruleFreshness(rs, { inForce, drafts: [] });
    expect(f.documents["omgevingsplan-draft"]!.status).toBe("not-listed");
    expect(f.staleRules).toEqual([]);
    expect(f.allCurrent).toBe(false);
  });
});
