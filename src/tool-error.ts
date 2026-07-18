import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { MissingTokenError } from "./config.js";
import { FusionError } from "./fusion-client.js";

// Public compatibility-sensitive contract: renaming/removing a code or changing
// its meaning is breaking and must follow the tool-contract versioning policy.
export const TOOL_ERROR_CODES = [
  "validation",
  "missing_token",
  "upstream_error",
  "timeout",
  "invalid_upstream_payload",
  "internal",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

// Serialized into tool-contract.json so same-major compatibility checks protect
// the canonical envelope and each stable code's meaning alongside input schemas.
export const TOOL_ERROR_CONTRACT = {
  envelopeVersion: 1,
  isError: true,
  contentType: "text",
  textEncoding: "json",
  requiredFields: ["error", "error.code", "error.message"],
  optionalFields: ["error.status", "error.details"],
  codes: [
    { code: "validation", meaning: "tool arguments failed validation" },
    { code: "missing_token", meaning: "authentication token is not configured" },
    { code: "upstream_error", meaning: "upstream HTTP or transport request failed" },
    { code: "timeout", meaning: "upstream request timed out" },
    {
      code: "invalid_upstream_payload",
      meaning: "upstream success payload could not be decoded or validated",
    },
    { code: "internal", meaning: "unexpected internal failure" },
  ],
  statusCodes: ["upstream_error", "invalid_upstream_payload"],
  detailsExtensible: true,
} as const satisfies {
  envelopeVersion: number;
  isError: true;
  contentType: "text";
  textEncoding: "json";
  requiredFields: readonly string[];
  optionalFields: readonly string[];
  codes: readonly { code: ToolErrorCode; meaning: string }[];
  statusCodes: readonly ToolErrorCode[];
  detailsExtensible: true;
};

export interface ToolErrorEnvelope {
  error: {
    code: ToolErrorCode;
    message: string;
    status?: number;
    details?: unknown;
  };
}

export interface ValidationIssue {
  path?: readonly PropertyKey[];
  message?: unknown;
}

function errorResult(envelope: ToolErrorEnvelope): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(envelope) }],
  };
}

function upstreamStatus(status: number | undefined): number | undefined {
  return Number.isInteger(status) && status !== undefined && status >= 100 && status <= 599
    ? status
    : undefined;
}

export function formatToolError(error: unknown): CallToolResult {
  if (error instanceof MissingTokenError) {
    return errorResult({
      error: {
        code: "missing_token",
        message: "Authentication token is required",
      },
    });
  }

  if (error instanceof FusionError) {
    switch (error.kind) {
      case "http": {
        const status = upstreamStatus(error.status);
        return errorResult({
          error: {
            code: "upstream_error",
            message: "Upstream request failed",
            ...(status === undefined ? {} : { status }),
          },
        });
      }
      case "timeout":
        return errorResult({
          error: {
            code: "timeout",
            message: "Upstream request timed out",
          },
        });
      case "invalid_payload": {
        const status = upstreamStatus(error.status);
        return errorResult({
          error: {
            code: "invalid_upstream_payload",
            message: "Upstream returned an invalid payload",
            ...(status === undefined ? {} : { status }),
          },
        });
      }
      case "network":
        return errorResult({
          error: {
            code: "upstream_error",
            message: "Upstream request failed",
          },
        });
    }
  }

  return errorResult({
    error: { code: "internal", message: "Internal error" },
  });
}

export function formatValidationError(
  issues: readonly ValidationIssue[],
): CallToolResult {
  return errorResult({
    error: {
      code: "validation",
      message: "Invalid tool arguments",
      details: issues.map((issue) => ({
        path: (issue.path ?? []).flatMap((part) =>
          typeof part === "string" || typeof part === "number" ? [part] : [],
        ),
        // Zod permits custom/refinement messages, which may contain received
        // argument values. Never serialize those untrusted messages.
        message: "Invalid argument",
      })),
    },
  });
}

export function withToolErrorEnvelope<Args extends unknown[]>(
  handler: (...args: Args) => CallToolResult | Promise<CallToolResult>,
): (...args: Args) => Promise<CallToolResult> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return formatToolError(error);
    }
  };
}
