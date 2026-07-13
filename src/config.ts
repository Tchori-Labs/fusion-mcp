import { z } from 'zod';

/**
 * Runtime configuration, parsed once from the environment.
 *
 * FUSION_TOKEN is optional here: the only endpoint that works without it is
 * `GET /api/health`. Any tool that hits an authenticated endpoint asks
 * {@link requireToken} for the token and fails loudly if it is missing, so a
 * health-only deployment can still start.
 */
export interface Config {
  /** Base URL of the Fusion daemon, no trailing slash. */
  baseUrl: string;
  /** Instance-wide daemon bearer token (`fn_<hex>`), if provided. */
  token?: string;
  /** Default project id applied when a tool call omits `projectId`. */
  defaultProjectId?: string;
  /** Port for the HTTP transport (ignored in stdio mode). */
  port: number;
  /** Per-request timeout in milliseconds for the Fusion HTTP client. */
  requestTimeoutMs: number;
}

// A trimmed string that is optional and collapses blank/whitespace to undefined,
// so `FUSION_TOKEN='  '` is treated as "not set" rather than a validation error.
const optionalTrimmed = z
  .string()
  .trim()
  .optional()
  .transform(value => (value && value.length > 0 ? value : undefined));

const rawSchema = z.object({
  FUSION_BASE_URL: z.string().trim().min(1).default('http://127.0.0.1:4040'),
  FUSION_TOKEN: optionalTrimmed,
  FUSION_DEFAULT_PROJECT_ID: optionalTrimmed,
  PORT: z.coerce.number().int().positive().max(65535).default(4141),
  FUSION_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
});

/**
 * Parse and validate configuration from a raw environment map.
 *
 * Accepts the environment explicitly so tests never depend on `process.env`.
 * Throws a `ZodError` with field-level messages on invalid input.
 */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = rawSchema.parse(env);

  // Normalise the base URL: reject anything that is not a real URL, and strip a
  // trailing slash so path joining stays predictable.
  let baseUrl: string;
  try {
    baseUrl = new URL(parsed.FUSION_BASE_URL).toString().replace(/\/$/, '');
  } catch {
    throw new Error(`FUSION_BASE_URL is not a valid URL: ${parsed.FUSION_BASE_URL}`);
  }

  return {
    baseUrl,
    token: parsed.FUSION_TOKEN,
    defaultProjectId: parsed.FUSION_DEFAULT_PROJECT_ID,
    port: parsed.PORT,
    requestTimeoutMs: parsed.FUSION_REQUEST_TIMEOUT_MS,
  };
}

/**
 * Return the token or throw a clear, token-free error. Call this from any tool
 * backed by an authenticated endpoint.
 */
export function requireToken(config: Config): string {
  if (!config.token) {
    throw new Error(
      'FUSION_TOKEN is required for this operation but was not set. ' +
        'Only GET /api/health works without a token.',
    );
  }
  return config.token;
}
