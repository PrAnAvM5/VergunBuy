/**
 * The DSO snapshot: which rule documents (and which exact versions) apply at a set of reference
 * points, taken once a day by a GitHub workflow and committed to the repository.
 *
 * Why: the website must keep working when our server or the DSO is down. The snapshot is the
 * fallback, and the daily comparison with the previous snapshot is the rule-change monitor.
 * A point whose search was incomplete keeps its last complete answer and its old date, so the
 * site can see exactly how old its knowledge is.
 */
import type { DsoDocument } from "./dso.ts";

export interface SnapshotPoint {
  name: string;
  x: number;
  y: number;
  /** When this point was last answered completely. */
  checkedAt: string;
  /** False when the latest attempt failed; documents are then from checkedAt. */
  latestAttemptComplete: boolean;
  fingerprint: string;
  documents: DsoDocument[];
  drafts: DsoDocument[];
}

export interface DsoSnapshot {
  schema: 1;
  takenAt: string;
  points: SnapshotPoint[];
}

export interface DocumentChange {
  kind: "added" | "removed" | "new-version" | "draft-added" | "draft-removed";
  workId: string;
  title: string;
  authority: string | null;
  from?: string | null;
  to?: string | null;
  points: string[];
}

const docKey = (d: DsoDocument) => d.workId;
const versionOf = (d: DsoDocument) =>
  d.expressionId ?? (d.version !== null ? `v${d.version}` : "?");
const draftKey = (d: DsoDocument) => d.technischId ?? d.expressionId ?? d.workId;

/** Every difference between two snapshots, one entry per document (points merged). */
export function diffSnapshots(prev: DsoSnapshot | null, next: DsoSnapshot): DocumentChange[] {
  const out = new Map<string, DocumentChange>();
  const add = (c: Omit<DocumentChange, "points">, point: string) => {
    const k = `${c.kind} ${c.workId} ${c.from ?? ""} ${c.to ?? ""}`;
    const have = out.get(k);
    if (have) have.points.push(point);
    else out.set(k, { ...c, points: [point] });
  };
  for (const p of next.points) {
    const old = prev?.points.find((q) => q.name === p.name);
    if (!old) continue; // a new reference point is not a rule change
    const before = new Map(old.documents.map((d) => [docKey(d), d]));
    const after = new Map(p.documents.map((d) => [docKey(d), d]));
    const meta = (d: DsoDocument) => ({
      workId: d.workId,
      title: d.title,
      authority: d.authority.name ?? d.authority.code,
    });
    for (const [k, d] of after) {
      const o = before.get(k);
      if (!o) add({ kind: "added", ...meta(d), to: versionOf(d) }, p.name);
      else if (versionOf(o) !== versionOf(d))
        add({ kind: "new-version", ...meta(d), from: versionOf(o), to: versionOf(d) }, p.name);
    }
    for (const [k, d] of before)
      if (!after.has(k)) add({ kind: "removed", ...meta(d), from: versionOf(d) }, p.name);
    const draftsBefore = new Map(old.drafts.map((d) => [draftKey(d), d]));
    const draftsAfter = new Map(p.drafts.map((d) => [draftKey(d), d]));
    for (const [k, d] of draftsAfter)
      if (!draftsBefore.has(k)) add({ kind: "draft-added", ...meta(d), to: versionOf(d) }, p.name);
    for (const [k, d] of draftsBefore)
      if (!draftsAfter.has(k))
        add({ kind: "draft-removed", ...meta(d), from: versionOf(d) }, p.name);
  }
  return [...out.values()];
}

const KIND_TEXT: Record<DocumentChange["kind"], string> = {
  added: "New rule document applies",
  removed: "Rule document no longer applies",
  "new-version": "New version in force",
  "draft-added": "New draft published",
  "draft-removed": "Draft withdrawn or adopted",
};

/** A readable report (GitHub issue body) of the changes. */
export function changesReport(changes: DocumentChange[], next: DsoSnapshot): string {
  const lines = [
    `DSO snapshot of ${next.takenAt} differs from the previous one.`,
    "",
    "Rule records based on these documents count as **changed since verified** until someone",
    "re-reads the articles and updates the record (source, article, version, verification date).",
    "",
  ];
  for (const c of changes) {
    lines.push(`- **${KIND_TEXT[c.kind]}**: ${c.title} (${c.authority ?? "unknown authority"})`);
    if (c.from || c.to) lines.push(`  - ${c.from ?? "—"} → ${c.to ?? "—"}`);
    lines.push(`  - at: ${c.points.join(", ")}`);
  }
  return lines.join("\n");
}
