// Vercel entry: bundled into one file by scripts/build-vercel.mjs (Build Output API v3).
import { handle } from "@hono/node-server/vercel";
import { createApp } from "./app.ts";
import { env } from "./config.ts";
import { createDso } from "./dso.ts";
import { createRp } from "./rp.ts";

export default handle(
  createApp({
    allowedOrigins: env.ALLOWED_ORIGINS,
    version: env.APP_VERSION,
    dso: createDso({
      keys: {
        ...(env.DSO_API_KEY ? { prod: env.DSO_API_KEY } : {}),
        ...(env.DSO_API_KEY_PRE ? { pre: env.DSO_API_KEY_PRE } : {}),
      },
    }),
    rp: createRp(env.RP_API_KEY ? { key: env.RP_API_KEY } : {}),
  }),
);
