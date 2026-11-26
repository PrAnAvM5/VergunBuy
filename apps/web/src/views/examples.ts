/**
 * Examples: every home from the validation runs, grouped by batch. Each opens the check page
 * replayed from its recording (same data as the report), next to its aerial check image.
 */
import { ACCESS_TEXT, esc } from "../format.ts";
import { lastExample } from "../remember.ts";

interface Home {
  label: string;
  village: string;
  access: string | null;
  route: string | null;
  flags: string[];
  houseType: string | null;
  error: string | null;
  /** Result when the batch was recorded, before later fixes. */
  recorded?: { access: string | null; route: string | null };
  postcode?: string;
  number?: string;
  addition?: string;
  rec?: string;
  image?: string;
}
interface Run {
  id: string;
  date: string;
  seed: number;
  homes: Home[];
}

export async function renderExamples(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="loading"><div class="spinner"></div>Loading the examples…</div>`;
  let runs: Run[];
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}validation/index.json`);
    if (!res.ok) throw new Error(String(res.status));
    runs = ((await res.json()) as { runs: Run[] }).runs;
  } catch {
    root.innerHTML = `<div class="card error-box" style="max-width:640px"><h2>The examples could not be loaded</h2><p class="muted">Try reloading the page.</p></div>`;
    return;
  }
  const total = runs.reduce((n, r) => n + r.homes.length, 0);

  const href = (h: Home) =>
    h.rec
      ? `#/check/${encodeURIComponent(h.postcode ?? "")}/${encodeURIComponent(h.number ?? "")}${h.addition ? `/${encodeURIComponent(h.addition)}` : ""}?rec=${encodeURIComponent(h.rec)}`
      : undefined;
  const row = (h: Home) => {
    const access = h.access ? ACCESS_TEXT[h.access] : undefined;
    const link = href(h);
    return `<li>${link ? `<a href="${link}">${esc(h.label.split(",")[0] ?? h.label)}</a>` : esc(h.label)} <span class="small muted">${esc(h.village)}</span> ${
      h.error
        ? `<span class="pill bad">Error</span>`
        : access
          ? `<span class="pill ${access.cls}">${esc(access.label)}</span>`
          : ""
    }</li>`;
  };
  const last = lastExample();
  const lastHome = last
    ? runs.flatMap((r) => r.homes).find((h) => h.rec && last.includes(encodeURIComponent(h.rec)))
    : undefined;
  root.innerHTML = `
    <div class="check-head"><div><h1>Examples</h1><p class="muted">${total} homes in ${runs.length} batches, replayed from recorded data.</p></div></div>
    ${lastHome && last ? `<p><a class="btn" href="${esc(last)}">← Back to ${esc(lastHome.label.split(",")[0] ?? lastHome.label)}</a></p>` : ""}
    ${runs
      .map(
        (r, i) =>
          `<details class="card ex-batch"><summary><h3>Batch ${runs.length - i}</h3><span class="sumnote">${r.homes.length} homes · ${esc(r.date)}</span></summary><ul class="ex-list">${r.homes.map(row).join("")}</ul></details>`,
      )
      .join("")}`;
}
