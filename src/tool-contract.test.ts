import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "./fusion-client.js";
import {
  diffToolContract,
  generateToolManifest,
  normalizeManifest,
  SPEC_TOOL_CATALOGUE,
  type JsonSchema,
  type ToolContractManifest,
} from "./tool-contract.js";

const committedManifest = JSON.parse(
  readFileSync(new URL("../tool-contract.json", import.meta.url), "utf8"),
) as ToolContractManifest;

function replaceSchema(
  manifest: ToolContractManifest,
  toolName: string,
  inputSchema: JsonSchema,
): ToolContractManifest {
  return {
    ...manifest,
    tools: manifest.tools.map((tool) =>
      tool.name === toolName ? { ...tool, inputSchema } : tool,
    ),
  };
}

function settingsSchema(propertySchema: JsonSchema, required = false): JsonSchema {
  return {
    type: "object",
    properties: { projectId: propertySchema },
    ...(required ? { required: ["projectId"] } : {}),
  };
}

function expectBreaking(
  baseline: ToolContractManifest,
  candidate: ToolContractManifest,
  kind: string,
): void {
  const result = diffToolContract(baseline, candidate);
  expect(result.compatible).toBe(false);
  expect(result.breaking.map((entry) => entry.kind)).toContain(kind);
}

describe("committed tool contract", () => {
  it("matches the normalized live in-memory MCP surface", async () => {
    const fetchMock = vi.fn<FetchLike>();

    const liveManifest = normalizeManifest(
      await generateToolManifest(undefined, fetchMock),
    );

    expect(
      liveManifest,
      "MCP tool contract drifted; run `pnpm contract:generate` and review the generated diff",
    ).toEqual(committedManifest);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("contains only tools governed by the SPEC catalogue", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const liveManifest = await generateToolManifest(undefined, fetchMock);
    const governedNames = new Set<string>(SPEC_TOOL_CATALOGUE);

    expect(
      liveManifest.tools.filter((tool) => !governedNames.has(tool.name)),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("diffToolContract compatible additions", () => {
  it("accepts a new optional property", () => {
    const candidate = replaceSchema(committedManifest, "read_project_settings", {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        region: { type: "string" },
      },
    });

    const result = diffToolContract(committedManifest, candidate);

    expect(result.compatible).toBe(true);
    expect(result.additive.map((entry) => entry.kind)).toContain("property-added");
  });

  it("accepts a loosened constraint", () => {
    const candidate = replaceSchema(
      committedManifest,
      "read_project_settings",
      settingsSchema({ type: "string", minLength: 0 }),
    );

    const result = diffToolContract(committedManifest, candidate);

    expect(result.compatible).toBe(true);
    expect(result.additive.map((entry) => entry.kind)).toContain(
      "constraint-loosened",
    );
  });

  it("accepts a new tool from the SPEC catalogue", () => {
    const candidate: ToolContractManifest = {
      ...committedManifest,
      tools: [
        ...committedManifest.tools,
        {
          name: "create_task",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };

    const result = diffToolContract(committedManifest, candidate);

    expect(result.compatible).toBe(true);
    expect(result.additive).toContainEqual(
      expect.objectContaining({ kind: "tool-added", tool: "create_task" }),
    );
  });
});

describe("diffToolContract breaking changes", () => {
  it("rejects a removed tool", () => {
    const candidate = {
      ...committedManifest,
      tools: committedManifest.tools.filter(
        (tool) => tool.name !== "read_project_settings",
      ),
    };

    expectBreaking(committedManifest, candidate, "tool-removed");
  });

  it("rejects a renamed tool", () => {
    const candidate = {
      ...committedManifest,
      tools: committedManifest.tools.map((tool) =>
        tool.name === "read_project_settings"
          ? { ...tool, name: "read_settings" }
          : tool,
      ),
    };

    expectBreaking(committedManifest, candidate, "tool-removed");
  });

  it("rejects a removed accepted property", () => {
    const candidate = replaceSchema(committedManifest, "read_project_settings", {
      type: "object",
      properties: {},
    });

    expectBreaking(committedManifest, candidate, "property-removed");
  });

  it("rejects an optional property becoming required", () => {
    const candidate = replaceSchema(
      committedManifest,
      "read_project_settings",
      settingsSchema({ type: "string", minLength: 1 }, true),
    );

    expectBreaking(committedManifest, candidate, "required-added");
  });

  it.each([
    ["type", { type: "number", minLength: 1 }, "type-changed"],
    ["format", { type: "string", minLength: 1, format: "uuid" }, "format-changed"],
  ])("rejects a property %s change", (_label, propertySchema, kind) => {
    const candidate = replaceSchema(
      committedManifest,
      "read_project_settings",
      settingsSchema(propertySchema),
    );

    expectBreaking(committedManifest, candidate, kind);
  });

  it("rejects a raised minimum", () => {
    const baseline = replaceSchema(
      committedManifest,
      "read_project_settings",
      settingsSchema({ type: "number", minimum: 1 }),
    );
    const candidate = replaceSchema(
      baseline,
      "read_project_settings",
      settingsSchema({ type: "number", minimum: 2 }),
    );

    expectBreaking(baseline, candidate, "constraint-tightened");
  });

  it("rejects a narrowed enum", () => {
    const baseline = replaceSchema(
      committedManifest,
      "read_project_settings",
      settingsSchema({ type: "string", enum: ["alpha", "beta"] }),
    );
    const candidate = replaceSchema(
      baseline,
      "read_project_settings",
      settingsSchema({ type: "string", enum: ["alpha"] }),
    );

    expectBreaking(baseline, candidate, "constraint-tightened");
  });

  it("rejects an added pattern", () => {
    const candidate = replaceSchema(
      committedManifest,
      "read_project_settings",
      settingsSchema({ type: "string", minLength: 1, pattern: "^[a-z]+$" }),
    );

    expectBreaking(committedManifest, candidate, "constraint-tightened");
  });

  it("rejects a tool outside the SPEC catalogue", () => {
    const candidate: ToolContractManifest = {
      ...committedManifest,
      tools: [
        ...committedManifest.tools,
        {
          name: "delete_task",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };

    expectBreaking(committedManifest, candidate, "ungoverned-tool");
  });
});
