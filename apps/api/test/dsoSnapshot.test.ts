import { describe, expect, it } from "vitest";
import { toDocument } from "../src/dso.ts";
import { changesReport, diffSnapshots, type DsoSnapshot } from "../src/dsoSnapshot.ts";

const doc = (id: string, v: number, title = id) =>
  toDocument({
    identificatie: id,
    expressionId: `${id};${v}`,
    officieleTitel: title,
    aangeleverdDoorEen: { code: "gm0873", naam: "Woensdrecht" },
  });

const snap = (documents: ReturnType<typeof doc>[], drafts: ReturnType<typeof doc>[] = []) =>
  ({
    schema: 1,
    takenAt: "2026-11-25T05:00:00Z",
    points: ["A", "B"].map((name) => ({
      name,
      x: 0,
      y: 0,
      checkedAt: "2026-11-25T05:00:00Z",
      latestAttemptComplete: true,
      fingerprint: "",
      documents,
      drafts,
    })),
  }) satisfies DsoSnapshot;

describe("DSO snapshot comparison", () => {
  it("finds nothing when nothing changed", () => {
    const s = snap([doc("plan", 3), doc("bbl", 12)]);
    expect(diffSnapshots(s, s)).toEqual([]);
    expect(diffSnapshots(null, s)).toEqual([]);
  });

  it("reports a new version once, with every point where it applies", () => {
    const changes = diffSnapshots(
      snap([doc("plan", 3, "Omgevingsplan")]),
      snap([doc("plan", 4, "Omgevingsplan")]),
    );
    expect(changes).toEqual([
      expect.objectContaining({
        kind: "new-version",
        from: "plan;3",
        to: "plan;4",
        points: ["A", "B"],
      }),
    ]);
    expect(changesReport(changes, snap([]))).toContain("changed since verified");
  });

  it("reports documents and drafts that appear or disappear", () => {
    const kinds = diffSnapshots(
      snap([doc("plan", 3), doc("old", 1)], [doc("draft1", 1)]),
      snap([doc("plan", 3), doc("new", 1)], [doc("draft2", 1)]),
    ).map((c) => `${c.kind} ${c.workId}`);
    expect(kinds.sort()).toEqual(
      ["added new", "removed old", "draft-added draft2", "draft-removed draft1"].sort(),
    );
  });
});
