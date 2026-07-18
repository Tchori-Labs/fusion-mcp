import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { MissingTokenError } from "./config.js";
import { FusionError, type FusionErrorKind } from "./fusion-client.js";
import {
  formatToolError,
  formatValidationError,
  TOOL_ERROR_CODES,
  withToolErrorEnvelope,
  type ToolErrorEnvelope,
} from "./tool-error.js";

const secretMarker = "distinctive-secret-marker";
const bodyMarker = "distinctive-upstream-body-marker";
const stackMarker = "distinctive-stack-marker";

function envelope(result: CallToolResult): ToolErrorEnvelope {
  expect(result.isError).toBe(true);
  const item = result.content[0];
  if (item?.type !== "text") {
    throw new Error("expected text tool result");
  }
  return JSON.parse(item.text) as ToolErrorEnvelope;
}

function fusionError(
  kind: FusionErrorKind,
  status?: number,
): FusionError {
  return new FusionError(`Safe ${kind} failure`, {
    method: "GET",
    path: "/api/tasks/FN-1",
    kind,
    ...(status === undefined ? {} : { status }),
  });
}

describe("tool error contract", () => {
  it("exports the exhaustive compatibility-sensitive code set", () => {
    expect(TOOL_ERROR_CODES).toEqual([
      "validation",
      "missing_token",
      "upstream_error",
      "timeout",
      "invalid_upstream_payload",
      "internal",
    ]);
  });

  it("maps missing tokens without a status", () => {
    expect(envelope(formatToolError(new MissingTokenError()))).toEqual({
      error: {
        code: "missing_token",
        message: "Authentication token is required",
      },
    });
  });

  it.each([
    {
      kind: "http" as const,
      status: 503,
      code: "upstream_error",
      expectedStatus: 503,
    },
    {
      kind: "network" as const,
      status: undefined,
      code: "upstream_error",
      expectedStatus: undefined,
    },
    {
      kind: "timeout" as const,
      status: undefined,
      code: "timeout",
      expectedStatus: undefined,
    },
    {
      kind: "invalid_payload" as const,
      status: 200,
      code: "invalid_upstream_payload",
      expectedStatus: 200,
    },
  ])("maps $kind FusionError to $code", ({ kind, status, code, expectedStatus }) => {
    const result = formatToolError(fusionError(kind, status));
    const parsed = envelope(result);

    expect(parsed.error).toMatchObject({
      code,
      message: `Safe ${kind} failure`,
      details: { method: "GET", path: "/api/tasks/FN-1" },
    });
    if (expectedStatus === undefined) {
      expect(parsed.error).not.toHaveProperty("status");
    } else {
      expect(parsed.error.status).toBe(expectedStatus);
    }
    expect(JSON.stringify(result)).not.toContain(bodyMarker);
    expect(JSON.stringify(result)).not.toContain(secretMarker);
  });

  it("uses a fixed internal message and omits error details", () => {
    const unexpected = new Error(
      `${secretMarker} ${bodyMarker} ${stackMarker}`,
    );
    unexpected.stack = `${stackMarker}\n${secretMarker}`;

    const result = formatToolError(unexpected);

    expect(envelope(result)).toEqual({
      error: { code: "internal", message: "Internal error" },
    });
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain(secretMarker);
    expect(rendered).not.toContain(bodyMarker);
    expect(rendered).not.toContain(stackMarker);
  });

  it("sanitizes validation issues to paths and messages", () => {
    const result = formatValidationError([
      { path: ["id"], message: "id is required" },
      {
        path: ["nested", Symbol(secretMarker), 1],
        message: undefined,
      },
    ]);

    expect(envelope(result)).toEqual({
      error: {
        code: "validation",
        message: "Invalid tool arguments",
        details: [
          { path: ["id"], message: "id is required" },
          { path: ["nested", 1], message: "Invalid argument" },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain(secretMarker);
  });

  it("leaves successful results unchanged and formats thrown failures", async () => {
    const success: CallToolResult = {
      content: [{ type: "text", text: '{"ok":true}' }],
    };
    const successfulHandler = withToolErrorEnvelope(async () => success);
    const failingHandler = withToolErrorEnvelope(async () => {
      throw new Error(secretMarker);
    });

    await expect(successfulHandler()).resolves.toBe(success);
    expect(envelope(await failingHandler()).error.code).toBe("internal");
  });
});
