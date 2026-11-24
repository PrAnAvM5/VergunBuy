/**
 * Hash router: #/            home (address search)
 *              #/check/<postcode>/<number>[/<addition>][?demo][&dev]
 *              #/system      System view of the last run
 *              #/about       How it works
 * Hash routes work on GitHub Pages without server configuration.
 */
import "./style.css";
import { renderAbout } from "./views/about.ts";
import { renderCheck } from "./views/check.ts";
import { renderHome } from "./views/home.ts";
import { renderSystem } from "./views/system.ts";

const app = document.querySelector<HTMLElement>("#app");

function route(): void {
  if (!app) return;
  const [path = "", search = ""] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(search);
  const parts = path.split("/").filter(Boolean);
  const page = parts[0] ?? "home";
  document.querySelectorAll<HTMLAnchorElement>("nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.nav === (page === "check" ? "home" : page));
  });
  window.scrollTo(0, 0);

  if (page === "check" && parts[1] && parts[2]) {
    const query = {
      postcode: decodeURIComponent(parts[1]),
      number: decodeURIComponent(parts[2]),
      ...(parts[3] ? { addition: decodeURIComponent(parts[3]) } : {}),
    };
    void renderCheck(app, query, params.has("demo") ? "demo" : "live", params.has("dev"));
  } else if (page === "system") renderSystem(app);
  else if (page === "about") renderAbout(app);
  else renderHome(app);
}

window.addEventListener("hashchange", route);
route();
