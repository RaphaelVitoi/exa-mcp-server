import { z } from "zod";

const OptionalUrlSchema = z
  .string()
  .optional()
  .transform((val) => {
    const trimmed = val?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  })
  .pipe(z.string().url().optional());

export const EnvSchema = z.object({
  EXA_API_KEY: z.string().optional(),
  DEBUG: z
    .string()
    .optional()
    .transform((val) => val === "true"),
  ENABLED_TOOLS: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
    ),
  OAUTH_USER_AGENTS: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    ),
  RATE_LIMIT_BYPASS: z.string().optional(),
  EXA_API_KEY_BYPASS: z.string().optional(),
  RATE_LIMIT_QPS: z
    .string()
    .optional()
    .default("2")
    .transform((val) => Number.parseInt(val || "2", 10))
    .pipe(z.number().positive()),
  RATE_LIMIT_DAILY: z
    .string()
    .optional()
    .default("50")
    .transform((val) => Number.parseInt(val || "50", 10))
    .pipe(z.number().positive()),
  KV_REST_API_URL: OptionalUrlSchema,
  KV_REST_API_TOKEN: z.string().optional(),
  UPSTASH_REDIS_REST_URL: OptionalUrlSchema,
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  AGNOST_LOG_LEVEL: z.string().optional().default("error"),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export function parseEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    return EnvSchema.parse({});
  }
  return result.data;
}
