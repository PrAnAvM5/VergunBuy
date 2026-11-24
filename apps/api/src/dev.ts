import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { env } from "./config.ts";

const app = createApp({ allowedOrigins: env.ALLOWED_ORIGINS, version: env.APP_VERSION });

serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  console.log(`VergunBuy API on http://localhost:${port}/api/health`);
});
