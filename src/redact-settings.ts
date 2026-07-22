export const REDACTED = "[REDACTED]";

const CREDENTIAL_KEY_PATTERN = /token|secret|passphrase|credential/i;

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Returns a deep, redacted copy of a settings payload without mutating it.
 * Credential-bearing object properties are masked wholesale, regardless of
 * their value type. Non-plain objects are left unchanged.
 */
export function redactSettings(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSettings(item));
  }

  if (typeof value !== "object" || value === null || !isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      key === "daemonToken" || CREDENTIAL_KEY_PATTERN.test(key)
        ? REDACTED
        : redactSettings(entryValue),
    ]),
  );
}
