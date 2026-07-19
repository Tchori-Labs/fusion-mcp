const DEFAULT_BASE_URL = "http://127.0.0.1:4040";
const DEFAULT_PORT = 4141;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
// Match the bounded integer range used by PORT and reject impractical delays.
const MAX_REQUEST_TIMEOUT_MS = 65_535;

export interface Config {
  baseUrl: string;
  token?: string;
  defaultProjectId?: string;
  port: number;
  requestTimeoutMs: number;
}

export type Environment = Record<string, string | undefined>;

export class MissingTokenError extends Error {
  constructor() {
    super("FUSION_TOKEN is required for authenticated operations");
    this.name = "MissingTokenError";
  }
}

function optionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === "" ? undefined : normalized;
}

function parseBaseUrl(value: string | undefined): string {
  const candidate = value === undefined ? DEFAULT_BASE_URL : value.trim();

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("FUSION_BASE_URL must be a valid HTTP or HTTPS URL");
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new Error("FUSION_BASE_URL must be a valid HTTP or HTTPS URL");
  }

  return parsed.toString().replace(/\/+$/, "");
}

function parseInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
  maximum?: number,
): number {
  const candidate = value === undefined ? String(defaultValue) : value.trim();
  if (!/^[1-9]\d*$/.test(candidate)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (maximum !== undefined && parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }

  return parsed;
}

export function parseConfig(env: Environment = process.env): Config {
  const token = optionalValue(env.FUSION_TOKEN);
  const defaultProjectId = optionalValue(env.FUSION_DEFAULT_PROJECT_ID);

  return {
    baseUrl: parseBaseUrl(env.FUSION_BASE_URL),
    ...(token === undefined ? {} : { token }),
    ...(defaultProjectId === undefined ? {} : { defaultProjectId }),
    port: parseInteger("PORT", env.PORT, DEFAULT_PORT, 65_535),
    requestTimeoutMs: parseInteger(
      "FUSION_REQUEST_TIMEOUT_MS",
      env.FUSION_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
    ),
  };
}

export function requireToken(config: Config): string {
  if (config.token === undefined) {
    throw new MissingTokenError();
  }
  return config.token;
}
