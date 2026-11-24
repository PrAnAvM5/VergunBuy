import { defineConfig } from "vite";

// GitHub Pages serves the site under /VergunBuy/. Locally it is served from /.
export default defineConfig({
  base: process.env.PAGES_BASE ?? "/",
  server: { fs: { allow: ["../.."] } },
  build: { target: "es2022", chunkSizeWarningLimit: 900 },
});
