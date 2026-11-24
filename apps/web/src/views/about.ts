export function renderAbout(root: HTMLElement): void {
  root.innerHTML = `
  <div style="max-width:760px">
    <h1>How VergunBuy works</h1>
    <p class="muted" style="font-size:17px">VergunBuy turns an address into a clear answer about what you may build, using only public data and the municipality's own rules. Every answer shows where it comes from.</p>
    <div class="card" style="margin:22px 0">
      <h2>Three promises</h2>
      <p><strong>Never a false "yes".</strong> A position is only shown as allowed when every check passes on data we actually have. Missing data never counts as a pass.</p>
      <p><strong>Plain answers, full detail underneath.</strong> You see allowed, needs a check, or not allowed, with one line saying why. Click anything to see the data and source behind it.</p>
      <p style="margin-bottom:0"><strong>Honest about gaps.</strong> Registers lag behind reality: a recent shed or extension may not be registered yet. When something like that could change the answer, we say so.</p>
    </div>
    <h2>Where the data comes from</h2>
    <table class="src card" style="padding:0">
      <tr><th>What</th><th>Register</th></tr>
      <tr><td>Address</td><td>BAG, via PDOK Locatieserver</td></tr>
      <tr><td>Plot outline</td><td>BRK Kadastrale kaart (Kadaster), CC BY 4.0. Indicative boundaries.</td></tr>
      <tr><td>House and neighbours</td><td>BAG (building register), public domain</td></tr>
      <tr><td>Streets, paths, green, water</td><td>BGT (large-scale topography), CC0</td></tr>
      <tr><td>Rules</td><td>Omgevingsplan Woensdrecht, chapter 22 (bruidsschat), versioned in the source code</td></tr>
    </table>
    <p class="small muted" style="margin-top:22px">VergunBuy gives information, not legal advice. For certainty, ask the municipality or use the official Vergunningcheck in the Omgevingsloket.</p>
  </div>`;
}
