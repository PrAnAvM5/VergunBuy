import { z } from "zod";

/** Environment is validated at startup: a missing or malformed setting fails fast and loudly. */
const Env = z.object({
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  APP_VERSION: z.string().default("dev"),
  PORT: z.coerce.number().int().default(8787),
});

export const env = Env.parse(process.env);
