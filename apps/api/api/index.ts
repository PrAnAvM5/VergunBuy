// Vercel Function entry point. vercel.json routes every /api/* request here.
import { handle } from "@hono/node-server/vercel";
import { createApp } from "../src/app.ts";
import { env } from "../src/config.ts";

export default handle(createApp({ allowedOrigins: env.ALLOWED_ORIGINS, version: env.APP_VERSION }));
