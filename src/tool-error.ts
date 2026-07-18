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
    const details = { method: error.method, path: error.path };
    switch (error.kind) {
      case "http":
        return errorResult({
          error: {
            code: "upstream_error",
            message: error.message,
            ...(error.status === undefined ? {} : { status: error.status }),
            details,
          },
        });
      case "timeout":
        return errorResult({
          error: {
            code: "timeout",
            message: error.message,
            details,
          },
        });
      case "invalid_payload":
        return errorResult({
          error: {
            code: "invalid_upstream_payload",
            message: error.message,
            ...(error.status === undefined ? {} : { status: error.status }),
            details,
          },
        });
      case "network":
        return errorResult({
          error: {
            code: "upstream_error",
            message: error.message,
            details,
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
        message:
          typeof issue.message === "string"
            ? issue.message
            : "Invalid argument",
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
