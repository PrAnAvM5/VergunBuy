/**
 * The last recorded example looked at (with its tab), so "Examples" in the menu brings you back
 * to it after visiting another page; the full list stays one click away from there.
 */
export function rememberExample(): void {
  const h = location.hash;
  try {
    if (h.startsWith("#/check/") && h.includes("rec=")) sessionStorage.setItem("lastExample", h);
    const last = sessionStorage.getItem("lastExample");
    const link = document.querySelector<HTMLAnchorElement>('nav a[data-nav="examples"]');
    if (link) link.href = last && !h.startsWith("#/examples") ? last : "#/examples";
  } catch {
    /* storage unavailable: the menu keeps pointing at the list */
  }
}

/** The last example's address and link, for the Examples page. */
export function lastExample(): string | null {
  try {
    return sessionStorage.getItem("lastExample");
  } catch {
    return null;
  }
}
