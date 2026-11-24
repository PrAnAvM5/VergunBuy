import { z } from "zod";

/** Environment is validated at startup: a missing or malformed setting fails fast and loudly. */
const Env = z.object({
  ALLOWED_ORIGINS: z
    .string()
    .default("https://pranavm5.github.io,http://localhost:5173,http://localhost:4173")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  APP_VERSION: z.string().default("dev"),
  /** DSO keys: secrets, set only in the hosting environment (never in code or chat). */
  DSO_API_KEY: z.string().min(10).optional(),
  DSO_API_KEY_PRE: z.string().min(10).optional(),
  PORT: z.coerce.number().int().default(8787),
});

export const env = Env.parse(process.env);
