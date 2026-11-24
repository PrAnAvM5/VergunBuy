import { DEMO } from "../run.ts";

export function renderHome(root: HTMLElement): void {
  root.innerHTML = `
  <section class="hero">
    <div>
      <h1>See what fits on a plot,<br/>before you buy or build.</h1>
      <p class="lead">Enter a Woensdrecht address. VergunBuy reads the real plot, house and street from public registers and shows how the rules apply, step by step and with sources.</p>
      <form class="search" id="search" novalidate>
        <div><label for="pc">Postcode</label><input type="text" id="pc" placeholder="4631 CC" autocomplete="postal-code" maxlength="7" /></div>
        <div><label for="nr">House number</label><input type="text" id="nr" placeholder="1" inputmode="numeric" maxlength="6" /></div>
        <div><label for="ad">Addition</label><input type="text" id="ad" placeholder="a" maxlength="6" /></div>
      </form>
      <div class="field-error" id="err" role="alert"></div>
      <div class="search-actions">
        <button class="btn-primary" form="search" type="submit">Check this address</button>
        <a class="btn" href="#/check/${DEMO.postcode}/${DEMO.number}?demo">Try a recorded example</a>
        <a class="btn" href="#/examples">Browse the validation homes</a>
      </div>
      <p class="note">Pilot: municipality of Woensdrecht (Hoogerheide, Huijbergen, Ossendrecht, Putte, Woensdrecht). First renovation type: carports.</p>
    </div>
    <div class="card">
      <h2>What happens when you check</h2>
      <div class="steps">
        <div class="step"><div class="step-n">1</div><div><h3>Find the address</h3><span class="muted small">National address register (BAG via PDOK).</span></div></div>
        <div class="step"><div class="step-n">2</div><div><h3>Draw the plot and house</h3><span class="muted small">Cadastral map (BRK) and building register (BAG).</span></div></div>
        <div class="step"><div class="step-n">3</div><div><h3>Read the surroundings</h3><span class="muted small">Streets, paths, green and water (BGT); neighbours and shared walls.</span></div></div>
        <div class="step"><div class="step-n">4</div><div><h3>Apply the rules</h3><span class="muted small">Each plot edge is classified, then the municipal rules are checked. Carport positions come next.</span></div></div>
      </div>
      <p class="small muted" style="margin-bottom:0">Every step is visible in the <a href="#/system">System view</a>, including what failed or is missing.</p>
    </div>
  </section>`;

  const form = root.querySelector<HTMLFormElement>("#search");
  const err = root.querySelector<HTMLElement>("#err");
  const pc = root.querySelector<HTMLInputElement>("#pc");
  const nr = root.querySelector<HTMLInputElement>("#nr");
  const ad = root.querySelector<HTMLInputElement>("#ad");
  [pc, nr, ad].forEach((i) => i?.addEventListener("input", () => err && (err.textContent = "")));
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const postcode = (pc?.value ?? "").replace(/\s+/g, "").toUpperCase();
    const number = (nr?.value ?? "").trim();
    const addition = (ad?.value ?? "").trim();
    if (!/^[1-9]\d{3}[A-Z]{2}$/.test(postcode)) {
      if (err) err.textContent = "Enter a Dutch postcode, like 4631 CC.";
      pc?.focus();
      return;
    }
    if (!/^\d{1,5}$/.test(number)) {
      if (err) err.textContent = "Enter a house number, like 12.";
      nr?.focus();
      return;
    }
    location.hash = `#/check/${postcode}/${number}${addition ? `/${encodeURIComponent(addition)}` : ""}`;
  });
}
