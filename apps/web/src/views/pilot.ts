/**
 * Pilot dashboard: how a change to VergunBuy moved the results on the 60 recorded example homes.
 * Reads snapshots made by scripts/pilot-snapshot.ts (same recordings each time) and compares two:
 * by default the newest against the one before it.
 */
import { esc } from "../format.ts";

type Outcome = "pass" | "fail" | "unknown";
interface First {
  colour: string;
  via: string | null;
  zone: string;
  rotation: number;
  checks: Record<string, Outcome>;
  routeM: number | null;
  shunts: number | null;
  backingIn: boolean;
  sweptShrubM2: number;
  sweptSolidM2: number;
  sweptPublicM2: number;
}
interface Opt {
  n: number;
  colours: Record<string, number>;
  best?: string;
  first?: First;
}
interface Home {
  run: string;
  error?: string;
  postcode?: string;
  number?: string;
  addition?: string;
  address?: string;
  place?: string;
  plotM2?: number;
  front?: { method: string; edge: number | null; rotation: number; street: string | null };
  edges?: Record<string, number>;
  streetSide?: Record<string, number>;
  exits?: { registered: number; onLineM: number; access: string | null };
  laser?: {
    echoes: number | null;
    infrared: boolean;
    objects: number;
    byKind: Record<string, number>;
    byMaterial: Record<string, number>;
    unclearShare: number | null;
    outsideCells: number;
    streetObjects: number | null;
  };
  quality?: Record<string, string>;
  steps?: Record<string, string>;
  ms?: { context: number; single?: number; double?: number };
  yard?: { backM2: number; frontKnown: boolean; method: string };
  carport?: { single: Opt; double: Opt } | null;
}
interface Snapshot {
  id: string;
  at: string;
  commitAt?: string;
  sha: string;
  subject: string;
  dirty: boolean;
  label: string;
  homes: Record<string, Home>;
}
interface IndexEntry {
  id: string;
  at: string;
  commitAt?: string;
  sha: string;
  subject: string;
  dirty: boolean;
  label: string;
  homes: number;
}

const base = `${import.meta.env.BASE_URL}pilot/`;
const cache = new Map<string, Snapshot>();
async function load(id: string): Promise<Snapshot> {
  const hit = cache.get(id);
  if (hit) return hit;
  const res = await fetch(`${base}${id}.json`);
  if (!res.ok) throw new Error(String(res.status));
  const s = (await res.json()) as Snapshot;
  cache.set(id, s);
  return s;
}

const VIA_TEXT: Record<string, string> = {
  existing: "Registered exit",
  probable: "Unregistered way in",
  unregistered: "Unregistered way in",
  "new-exit": "New exit (permit)",
  "through-barrier": "Through hedge/fence",
  none: "No way in",
};
const COLOUR_TEXT: Record<string, string> = {
  green: "Green",
  amber: "Amber",
  red: "Red",
  none: "No spot",
  "no-site": "No check (shared plot)",
  error: "Error",
};
const FRONT_TEXT: Record<string, string> = {
  "road-register": "Road register",
  "street-label": "Street-name label",
  agreed: "Two clues agree",
  "longest-public": "Estimated",
  none: "No public side",
};
const LINE_TEXT: Record<string, string> = {
  open: "Open",
  hedge: "Hedge",
  barrier: "Fence or wall",
  unknown: "Unclear",
  exit: "Registered exit",
};
const EDGE_TEXT: Record<string, string> = {
  public: "Street, path or green",
  neighbour: "Neighbour",
  "shared-wall": "Shared wall",
  "rear-path": "Rear path",
  water: "Water",
};
const OUTCOME_ORDER: Outcome[] = ["pass", "unknown", "fail"];

/** Result of option #1 for one size, as one word. */
const firstColour = (h: Home, size: "single" | "double") =>
  h.error
    ? "error"
    : h.carport === null || h.carport === undefined
      ? "no-site"
      : (h.carport[size].first?.colour ?? "none");
const firstVia = (h: Home) =>
  h.carport?.single.first ? (h.carport.single.first.via ?? "none") : null;
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const totalMs = (h: Home) => (h.ms ? h.ms.context + (h.ms.single ?? 0) + (h.ms.double ?? 0) : 0);
const sumBy = (hs: Home[], f: (h: Home) => Record<string, number> | undefined) => {
  const m: Record<string, number> = {};
  for (const h of hs) for (const [k, v] of Object.entries(f(h) ?? {})) m[k] = (m[k] ?? 0) + v;
  return m;
};
const r1 = (v: number) => Math.round(v * 10) / 10;
const COLOUR_RANK: Record<string, number> = {
  green: 0,
  amber: 1,
  red: 2,
  none: 3,
  "no-site": 3,
  error: 4,
};

function delta(a: number, b: number, goodUp: boolean | null, unit = ""): string {
  const d = r1(b - a);
  if (!d) return `<span class="pd-d">±0</span>`;
  const good = goodUp === null ? null : goodUp ? d > 0 : d < 0;
  return `<span class="pd-d ${good === null ? "" : good ? "up" : "down"}">${d > 0 ? "+" : ""}${d}${unit}</span>`;
}

function kpi(title: string, a: number, b: number, goodUp: boolean | null, unit = ""): string {
  return `<div class="pd-kpi"><div class="pd-kt">${esc(title)}</div><div class="pd-kv">${r1(b)}${unit}</div>${delta(a, b, goodUp, unit)}</div>`;
}

/** Rows: label, value in A, value in B (+ delta). */
function compareTable(
  title: string,
  rows: [string, number, number, boolean | null][],
  unit = "",
): string {
  const max = Math.max(1, ...rows.map((r) => Math.max(r[1], r[2])));
  return `<table class="pd-table"><thead><tr><th>${esc(title)}</th><th class="num">Before</th><th class="num">Now</th><th class="num">Change</th><th></th></tr></thead><tbody>${rows
    .map(
      ([l, a, b, g]) =>
        `<tr><td>${esc(l)}</td><td class="num">${r1(a)}${unit}</td><td class="num"><b>${r1(b)}${unit}</b></td><td class="num">${delta(a, b, g, unit)}</td><td class="pd-barcell"><span class="pd-bar a" style="width:${((a / max) * 100).toFixed(1)}%"></span><span class="pd-bar b" style="width:${((b / max) * 100).toFixed(1)}%"></span></td></tr>`,
    )
    .join("")}</tbody></table>`;
}

const homeLink = (id: string, h: Home, text: string) =>
  h.postcode
    ? `<a href="#/check/${encodeURIComponent(h.postcode)}/${encodeURIComponent(h.number ?? "")}${h.addition ? `/${encodeURIComponent(h.addition)}` : ""}?rec=${encodeURIComponent(`${h.run}/${id}`)}">${esc(text)}</a>`
    : esc(text);

interface Alert {
  level: "bad" | "warn";
  id: string;
  text: string;
}

function alerts(A: Snapshot, B: Snapshot): Alert[] {
  const out: Alert[] = [];
  for (const [id, b] of Object.entries(B.homes)) {
    const a = A.homes[id];
    const name = b.address ?? id;
    if (b.error) out.push({ level: "bad", id, text: `${name}: the check crashed (${b.error})` });
    // Never: green without a registered exit (zero false greens).
    for (const size of ["single", "double"] as const) {
      const f = b.carport?.[size].first;
      if (f?.colour === "green" && f.via !== "existing")
        out.push({
          level: "bad",
          id,
          text: `${name}: ${size} spot #1 is green without a registered exit (via ${f.via ?? "none"})`,
        });
    }
    if (!a || a.error) continue;
    if (b.front && a.front && b.front.method !== "none" && a.front.method !== "none") {
      // Smallest angle between the two front directions (0–180°).
      const d = Math.abs(((((b.front.rotation - a.front.rotation) % 360) + 540) % 360) - 180);
      if (d >= 60)
        out.push({
          level: "warn",
          id,
          text: `${name}: the front side turned ${Math.round(d)}° (${FRONT_TEXT[a.front.method] ?? a.front.method} → ${FRONT_TEXT[b.front.method] ?? b.front.method})`,
        });
    }
    if (a.exits && b.exits && a.exits.registered !== b.exits.registered)
      out.push({
        level: "warn",
        id,
        text: `${name}: registered exits ${a.exits.registered} → ${b.exits.registered}`,
      });
    const ca = firstColour(a, "single");
    const cb = firstColour(b, "single");
    if ((COLOUR_RANK[cb] ?? 0) > (COLOUR_RANK[ca] ?? 0))
      out.push({
        level: "warn",
        id,
        text: `${name}: spot #1 got worse, ${COLOUR_TEXT[ca] ?? ca} → ${COLOUR_TEXT[cb] ?? cb}`,
      });
    const ta = totalMs(a);
    const tb = totalMs(b);
    if (tb > 2 * ta && tb - ta > 2000)
      out.push({
        level: "warn",
        id,
        text: `${name}: much slower, ${(ta / 1000).toFixed(1)} s → ${(tb / 1000).toFixed(1)} s`,
      });
    for (const [step, st] of Object.entries(b.steps ?? {}))
      if (st !== "ok" && (a.steps?.[step] ?? "ok") === "ok")
        out.push({
          level: st === "failed" ? "bad" : "warn",
          id,
          text: `${name}: step “${step}” is now ${st}`,
        });
  }
  return out.sort((x, y) => (x.level === y.level ? 0 : x.level === "bad" ? -1 : 1));
}

interface Flip {
  id: string;
  h: Home;
  what: string[];
}
function flips(A: Snapshot, B: Snapshot): Flip[] {
  const out: Flip[] = [];
  for (const [id, b] of Object.entries(B.homes)) {
    const a = A.homes[id];
    if (!a) {
      out.push({ id, h: b, what: ["new home"] });
      continue;
    }
    const what: string[] = [];
    const cmp = (label: string, x: unknown, y: unknown) => {
      if (String(x) !== String(y)) what.push(`${label}: ${String(x)} → ${String(y)}`);
    };
    cmp("single #1", COLOUR_TEXT[firstColour(a, "single")], COLOUR_TEXT[firstColour(b, "single")]);
    cmp("double #1", COLOUR_TEXT[firstColour(a, "double")], COLOUR_TEXT[firstColour(b, "double")]);
    const va = firstVia(a);
    const vb = firstVia(b);
    if (va !== null && vb !== null) cmp("way in", VIA_TEXT[va] ?? va, VIA_TEXT[vb] ?? vb);
    cmp("spots", a.carport?.single.n ?? 0, b.carport?.single.n ?? 0);
    if (a.front && b.front) {
      cmp("front from", FRONT_TEXT[a.front.method], FRONT_TEXT[b.front.method]);
      if (a.front.edge !== b.front.edge || a.front.rotation !== b.front.rotation)
        what.push(`front side: ${a.front.rotation}° → ${b.front.rotation}°`);
    }
    cmp("registered exits", a.exits?.registered ?? "–", b.exits?.registered ?? "–");
    if (
      a.yard &&
      b.yard &&
      Math.abs(a.yard.backM2 - b.yard.backM2) > Math.max(5, 0.1 * a.yard.backM2)
    )
      what.push(`back yard: ${a.yard.backM2} → ${b.yard.backM2} m²`);
    if (what.length) out.push({ id, h: b, what });
  }
  return out;
}

function trend(snaps: Snapshot[], f: (s: Snapshot) => number, title: string): string {
  const vals = snaps.map(f);
  const W = 180;
  const H = 40;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const x = (i: number) => (snaps.length < 2 ? W / 2 : 4 + (i * (W - 8)) / (snaps.length - 1));
  const y = (v: number) => (hi === lo ? H / 2 : H - 4 - ((v - lo) / (hi - lo)) * (H - 8));
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return `<div class="pd-trend"><div class="pd-kt">${esc(title)}</div><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2"/>${vals
    .map(
      (v, i) =>
        `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="var(--accent)"><title>${esc(snaps[i]!.id)}: ${r1(v)}</title></circle>`,
    )
    .join(
      "",
    )}</svg><div class="small muted">${r1(vals[0] ?? 0)} → <b>${r1(vals[vals.length - 1] ?? 0)}</b></div></div>`;
}

const homesOf = (s: Snapshot) => Object.values(s.homes);
const ok = (s: Snapshot) => homesOf(s).filter((h) => !h.error);

function section(title: string, note: string, body: string, open = true): string {
  return `<details class="card pd-sec"${open ? " open" : ""}><summary><h2>${esc(title)}</h2><span class="sumnote">${esc(note)}</span></summary>${body}</details>`;
}

function render(root: HTMLElement, index: IndexEntry[], A: Snapshot, B: Snapshot, all: Snapshot[]) {
  const ha = ok(A);
  const hb = ok(B);
  const opt = (s: IndexEntry, sel: string) =>
    `<option value="${esc(s.id)}"${s.id === sel ? " selected" : ""}>${esc((s.commitAt ?? s.at).slice(0, 16).replace("T", " "))} · ${esc(s.sha)}${s.dirty ? "*" : ""} · ${esc(s.label || s.subject).slice(0, 60)}</option>`;
  const colourRows = (size: "single" | "double") =>
    (["green", "amber", "red", "none", "no-site", "error"] as const).map(
      (c) =>
        [
          COLOUR_TEXT[c]!,
          homesOf(A).filter((h) => firstColour(h, size) === c).length,
          homesOf(B).filter((h) => firstColour(h, size) === c).length,
          c === "green" ? true : c === "amber" ? null : false,
        ] as [string, number, number, boolean | null],
    );
  const viaKeys = ["existing", "probable", "new-exit", "through-barrier", "none"];
  const viaRows = viaKeys.map(
    (k) =>
      [
        VIA_TEXT[k]!,
        ha.filter((h) => (firstVia(h) === "unregistered" ? "probable" : firstVia(h)) === k).length,
        hb.filter((h) => (firstVia(h) === "unregistered" ? "probable" : firstVia(h)) === k).length,
        k === "existing" ? true : null,
      ] as [string, number, number, boolean | null],
  );
  const greens = (s: Snapshot) =>
    homesOf(s).filter((h) => firstColour(h, "single") === "green").length;
  const anyGreen = (s: Snapshot) =>
    homesOf(s).filter((h) => h.carport?.single.best === "green").length;
  const msMed = (s: Snapshot) => median(ok(s).map(totalMs)) / 1000;
  const msMax = (s: Snapshot) => Math.max(0, ...ok(s).map(totalMs)) / 1000;
  const regExitHomes = (s: Snapshot) => ok(s).filter((h) => (h.exits?.registered ?? 0) > 0).length;
  const frontKnown = (s: Snapshot) =>
    ok(s).filter((h) => h.front && !["longest-public", "none"].includes(h.front.method)).length;
  const al = alerts(A, B);
  const fl = flips(A, B);

  // Checks: outcome of each rule check for single spot #1.
  const checkIds = [
    ...new Set([...ha, ...hb].flatMap((h) => Object.keys(h.carport?.single.first?.checks ?? {}))),
  ];
  const checkCount = (hs: Home[], id: string, o: Outcome) =>
    hs.filter((h) => h.carport?.single.first?.checks[id] === o).length;
  const checksTable = `<table class="pd-table"><thead><tr><th>Check (single spot #1)</th>${OUTCOME_ORDER.map((o) => `<th class="num">${o === "pass" ? "✓ pass" : o === "unknown" ? "? check" : "✕ fail"}</th>`).join("")}</tr></thead><tbody>${checkIds
    .map(
      (id) =>
        `<tr><td><code>${esc(id)}</code></td>${OUTCOME_ORDER.map((o) => {
          const a = checkCount(ha, id, o);
          const b = checkCount(hb, id, o);
          return `<td class="num"><b>${b}</b> ${delta(a, b, o === "pass" ? true : o === "fail" ? false : null)}</td>`;
        }).join("")}</tr>`,
    )
    .join("")}</tbody></table>`;

  // Street side and edges (metres summed over all homes).
  const lineA = sumBy(ha, (h) => h.streetSide);
  const lineB = sumBy(hb, (h) => h.streetSide);
  const edgeA = sumBy(ha, (h) => h.edges);
  const edgeB = sumBy(hb, (h) => h.edges);
  const accessKeys = [...new Set([...ha, ...hb].map((h) => h.exits?.access ?? "–"))];
  // Laser.
  const matA = sumBy(ha, (h) => h.laser?.byMaterial);
  const matB = sumBy(hb, (h) => h.laser?.byMaterial);
  const matKeys = [...new Set([...Object.keys(matA), ...Object.keys(matB)])].sort();
  const MAT_TEXT: Record<string, string> = {
    "tall-plant": "Tall, plant (tree)",
    "tall-solid": "Tall, solid",
    "tall-unknown": "Tall, unclear",
    "low-plant": "Low, plant (shrub)",
    "low-solid": "Low, solid",
    "low-unknown": "Low, unclear",
  };
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  // Data health: steps and quality.
  const stepIds = [...new Set(hb.flatMap((h) => Object.keys(h.steps ?? {})))];
  const stepRow = (id: string) => {
    const c = (hs: Home[], st: string) => hs.filter((h) => h.steps?.[id] === st).length;
    return `<tr><td><code>${esc(id)}</code></td>${["ok", "degraded", "failed"].map((st) => `<td class="num"><b>${c(hb, st)}</b> ${delta(c(ha, st), c(hb, st), st === "ok" ? true : false)}</td>`).join("")}</tr>`;
  };
  const domains = [...new Set(hb.flatMap((h) => Object.keys(h.quality ?? {})))];
  const qRow = (d: string) => {
    const c = (hs: Home[], st: string) => hs.filter((h) => h.quality?.[d] === st).length;
    return `<tr><td>${esc(d)}</td>${["complete", "assumed", "partial", "missing"].map((st) => `<td class="num"><b>${c(hb, st)}</b> ${delta(c(ha, st), c(hb, st), st === "complete" ? true : false)}</td>`).join("")}</tr>`;
  };

  root.innerHTML = `
  <section class="pd">
    <div class="pd-head">
      <div>
        <h1>Pilot dashboard</h1>
        <p class="muted small">The 60 example homes, replayed from the same recordings for every snapshot: what a change to VergunBuy moved. A snapshot is taken on request (<code>pnpm tsx scripts/pilot-snapshot.ts "label"</code>).</p>
      </div>
      <div class="pd-pick">
        <label>Before <select id="pd-a">${index.map((s) => opt(s, A.id)).join("")}</select></label>
        <label>Now <select id="pd-b">${index.map((s) => opt(s, B.id)).join("")}</select></label>
      </div>
    </div>
    <p class="small muted">Now: <b>${esc(B.label || B.subject)}</b> (${esc(B.sha)}${B.dirty ? ", with uncommitted changes" : ""}) · Before: ${esc(A.label || A.subject)} (${esc(A.sha)})${A.id === B.id ? " · only one snapshot so far: changes appear from the next one" : ""}</p>

    <div class="pd-kpis">
      ${kpi("Green spot #1 (single)", greens(A), greens(B), true)}
      ${kpi("Homes with any green spot", anyGreen(A), anyGreen(B), true)}
      ${kpi("No spot (single)", homesOf(A).filter((h) => firstColour(h, "single") === "none").length, homesOf(B).filter((h) => firstColour(h, "single") === "none").length, false)}
      ${kpi("Homes with a registered exit", regExitHomes(A), regExitHomes(B), null)}
      ${kpi("Front known (not estimated)", frontKnown(A), frontKnown(B), true)}
      ${kpi("Errors", homesOf(A).filter((h) => h.error).length, homesOf(B).filter((h) => h.error).length, false)}
      ${kpi("Median time per home", msMed(A), msMed(B), false, " s")}
      ${kpi("Slowest home", msMax(A), msMax(B), false, " s")}
    </div>

    ${
      all.length > 1
        ? `<div class="pd-trends">${trend(all, greens, "Green #1")}${trend(all, (s) => homesOf(s).filter((h) => firstColour(h, "single") === "amber").length, "Amber #1")}${trend(all, (s) => homesOf(s).filter((h) => firstColour(h, "single") === "none").length, "No spot")}${trend(all, frontKnown, "Front known")}${trend(all, msMed, "Median s")}</div>`
        : ""
    }

    ${section(
      "Alerts",
      al.length ? `${al.length} to look at` : "nothing unusual",
      al.length
        ? `<ul class="pd-alerts">${al.map((x) => `<li class="${x.level}">${homeLink(x.id, B.homes[x.id]!, "open")} ${esc(x.text)}</li>`).join("")}</ul>`
        : `<p class="muted">No crashes, no green without a registered exit, no front flips, no exits appearing or disappearing, no results getting worse, no big slowdowns.</p>`,
    )}

    ${section(
      "Results",
      "option #1 per home, and how the car gets in",
      `<div class="pd-grid">${compareTable("Single carport, spot #1", colourRows("single"))}${compareTable("Double carport, spot #1", colourRows("double"))}${compareTable("Way in for single spot #1", viaRows)}</div>`,
    )}

    ${section(
      "Homes that changed",
      fl.length ? `${fl.length} homes` : "none",
      fl.length
        ? `<table class="pd-table"><thead><tr><th>Home</th><th>What changed</th></tr></thead><tbody>${fl
            .map(
              (f) =>
                `<tr><td>${homeLink(f.id, f.h, f.h.address ?? f.id)} <span class="small muted">${esc(f.h.place ?? "")}</span></td><td>${f.what.map(esc).join("<br>")}</td></tr>`,
            )
            .join("")}</tbody></table>`
        : `<p class="muted">Every home gives the same result as before.</p>`,
    )}

    ${section("Rule checks", "single spot #1, per check", checksTable, false)}

    ${section(
      "Street side and edges",
      "metres over all homes",
      `<div class="pd-grid">${compareTable(
        "What stands on the street side (laser scan)",
        Object.keys(LINE_TEXT).map((k) => [LINE_TEXT[k]!, lineA[k] ?? 0, lineB[k] ?? 0, null]),
        " m",
      )}${compareTable(
        "Plot edges by what lies beyond",
        Object.keys(EDGE_TEXT).map((k) => [EDGE_TEXT[k]!, edgeA[k] ?? 0, edgeB[k] ?? 0, null]),
        " m",
      )}${compareTable(
        "Way in from the map (homes)",
        accessKeys.map((k) => [
          k,
          ha.filter((h) => (h.exits?.access ?? "–") === k).length,
          hb.filter((h) => (h.exits?.access ?? "–") === k).length,
          null,
        ]),
      )}${compareTable("Registered exit on the plot line", [
        [
          "Exit metres (all homes)",
          ha.reduce((m, h) => m + (h.exits?.onLineM ?? 0), 0),
          hb.reduce((m, h) => m + (h.exits?.onLineM ?? 0), 0),
          null,
        ],
        [
          "Registered crossings",
          ha.reduce((m, h) => m + (h.exits?.registered ?? 0), 0),
          hb.reduce((m, h) => m + (h.exits?.registered ?? 0), 0),
          null,
        ],
      ])}</div>`,
      false,
    )}

    ${section(
      "Laser scan",
      "objects found and how sure the plant/solid reading is",
      `<div class="pd-grid">${compareTable(
        "Scanned objects by height and material",
        matKeys.map((k) => [MAT_TEXT[k] ?? k, matA[k] ?? 0, matB[k] ?? 0, null]),
      )}${compareTable("Robustness", [
        [
          "Avg. cells unclear (plant or solid), %",
          avg(ha.map((h) => h.laser?.unclearShare ?? 0)),
          avg(hb.map((h) => h.laser?.unclearShare ?? 0)),
          false,
        ],
        [
          "Homes without laser echoes",
          ha.filter((h) => !h.laser?.echoes).length,
          hb.filter((h) => !h.laser?.echoes).length,
          false,
        ],
        [
          "Homes without infrared",
          ha.filter((h) => !h.laser?.infrared).length,
          hb.filter((h) => !h.laser?.infrared).length,
          false,
        ],
        [
          "Cells on verges/public green",
          ha.reduce((m, h) => m + (h.laser?.outsideCells ?? 0), 0),
          hb.reduce((m, h) => m + (h.laser?.outsideCells ?? 0), 0),
          null,
        ],
        [
          "Street objects (lamp posts…)",
          ha.reduce((m, h) => m + (h.laser?.streetObjects ?? 0), 0),
          hb.reduce((m, h) => m + (h.laser?.streetObjects ?? 0), 0),
          null,
        ],
      ])}</div>`,
      false,
    )}

    ${section(
      "Front and back yard",
      "how the front is decided and how much back yard results",
      `<div class="pd-grid">${compareTable(
        "Front decided by (homes)",
        Object.keys(FRONT_TEXT).map((k) => [
          FRONT_TEXT[k]!,
          ha.filter((h) => h.front?.method === k).length,
          hb.filter((h) => h.front?.method === k).length,
          k === "longest-public" ? false : null,
        ]),
      )}${compareTable("Back yard", [
        [
          "Median back-yard area, m²",
          median(ha.map((h) => h.yard?.backM2 ?? 0).filter(Boolean)),
          median(hb.map((h) => h.yard?.backM2 ?? 0).filter(Boolean)),
          null,
        ],
        [
          "Homes with no back yard",
          ha.filter((h) => h.yard && h.yard.backM2 < 1).length,
          hb.filter((h) => h.yard && h.yard.backM2 < 1).length,
          false,
        ],
        [
          "Spot #1 in the back yard",
          ha.filter((h) => h.carport?.single.first?.zone === "back").length,
          hb.filter((h) => h.carport?.single.first?.zone === "back").length,
          true,
        ],
        [
          "Spot #1 turned (not 0°/90°)",
          ha.filter((h) => (h.carport?.single.first?.rotation ?? 0) % 90).length,
          hb.filter((h) => (h.carport?.single.first?.rotation ?? 0) % 90).length,
          null,
        ],
        [
          "Spot #1 with shunts",
          ha.filter((h) => (h.carport?.single.first?.shunts ?? 0) > 0).length,
          hb.filter((h) => (h.carport?.single.first?.shunts ?? 0) > 0).length,
          null,
        ],
        [
          "Spot #1 backing in",
          ha.filter((h) => h.carport?.single.first?.backingIn).length,
          hb.filter((h) => h.carport?.single.first?.backingIn).length,
          null,
        ],
      ])}</div>`,
      false,
    )}

    ${section(
      "Data health",
      "each data step and quality domain over the 60 homes",
      `<div class="pd-grid"><table class="pd-table"><thead><tr><th>Step</th><th class="num">ok</th><th class="num">degraded</th><th class="num">failed</th></tr></thead><tbody>${stepIds.map(stepRow).join("")}</tbody></table><table class="pd-table"><thead><tr><th>Quality</th><th class="num">complete</th><th class="num">assumed</th><th class="num">partial</th><th class="num">missing</th></tr></thead><tbody>${domains.map(qRow).join("")}</tbody></table></div>`,
      false,
    )}
  </section>`;

  const pick = async () => {
    const a = (root.querySelector("#pd-a") as HTMLSelectElement).value;
    const b = (root.querySelector("#pd-b") as HTMLSelectElement).value;
    render(root, index, await load(a), await load(b), all);
  };
  root.querySelector("#pd-a")?.addEventListener("change", () => void pick());
  root.querySelector("#pd-b")?.addEventListener("change", () => void pick());
}

export async function renderPilot(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="loading"><div class="spinner"></div>Loading the pilot snapshots…</div>`;
  try {
    const res = await fetch(`${base}index.json`);
    if (!res.ok) throw new Error(String(res.status));
    // Newest code version first (a snapshot of older code may be taken later).
    const key = (s: IndexEntry) => `${s.commitAt ?? s.at}|${s.at}`;
    const index = ((await res.json()) as { snapshots: IndexEntry[] }).snapshots.sort((a, b) =>
      key(a) < key(b) ? 1 : -1,
    );
    if (!index.length) throw new Error("no snapshots");
    const all = await Promise.all([...index].reverse().map((s) => load(s.id)));
    const B = all[all.length - 1]!;
    const A = all[all.length - 2] ?? B;
    render(root, index, A, B, all);
  } catch {
    root.innerHTML = `<div class="card error-box" style="max-width:640px"><h2>No pilot snapshots yet</h2><p class="muted">Take one with <code>pnpm tsx scripts/pilot-snapshot.ts "label"</code>, commit the files in <code>apps/web/public/pilot</code>, and reload.</p></div>`;
  }
}
