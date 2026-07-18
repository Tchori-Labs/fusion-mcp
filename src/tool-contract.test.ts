import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "./fusion-client.js";
import {
  diffToolContract,
  generateToolManifest,
  normalizeManifest,
  packageMajor,
  SPEC_TOOL_CATALOGUE,
  SPEC_TOOL_INPUT_PROPERTIES,
  type JsonSchema,
  type ToolContractArtifact,
  type ToolContractManifest,
  updateToolContractArtifact,
} from "./tool-contract.js";

const committedArtifact = JSON.parse(
  readFileSync(new URL("../tool-contract.json", import.meta.url), "utf8"),
) as ToolContractArtifact;
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const spec = readFileSync(new URL("../SPEC.md", import.meta.url), "utf8");
const currentPackageMajor = packageMajor(packageJson.version);
const publishedBaselines = committedArtifact.baselines.filter(
  (baseline) => baseline.packageMajor === currentPackageMajor,
);
const committedManifest = publishedBaselines.at(-1);

if (committedManifest === undefined) {
  throw new Error(
    `tool-contract.json has no baseline for package major ${currentPackageMajor}`,
  );
}

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

function requiredErrorContract(manifest: ToolContractManifest) {
  if (manifest.errorContract === undefined) {
    throw new Error("manifest has no canonical error contract");
  }
  return manifest.errorContract;
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

function parseSpecToolCatalogue(
  markdown: string,
): Record<string, readonly string[]> {
  const section = markdown.match(
    /## Tool catalogue(?<catalogue>[\s\S]*?)(?:\n## |$)/u,
  )?.groups?.catalogue;
  if (section === undefined) {
    throw new Error("SPEC.md has no Tool catalogue section");
  }

  return Object.fromEntries(
    [
      ...section.matchAll(
        /^\|\s*`(?<tool>[^`]+)`\s*\|[^|]*\|(?<params>[^|]*)\|/gmu,
      ),
    ].map(({ groups }) => {
      if (groups?.tool === undefined || groups.params === undefined) {
        throw new Error("could not parse a SPEC.md Tool catalogue row");
      }
      const properties = [
        ...groups.params.matchAll(
          /`(?<name>[A-Za-z][A-Za-z0-9]*)(?:\?)?\s*:/gu,
        ),
      ].map(({ groups: propertyGroups }) => {
        if (propertyGroups?.name === undefined) {
          throw new Error(`could not parse parameters for ${groups.tool}`);
        }
        return propertyGroups.name;
      });
      return [groups.tool, properties] as const;
    }),
  );
}

describe("committed tool contract", () => {
  it("keeps the enforcement allowlist synchronized with the SPEC catalogue", () => {
    expect(parseSpecToolCatalogue(spec)).toEqual(SPEC_TOOL_INPUT_PROPERTIES);
  });

  it("is compatible with every published baseline in the package major", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const liveManifest = normalizeManifest(
      await generateToolManifest(undefined, fetchMock),
    );

    expect(publishedBaselines.length).toBeGreaterThan(0);
    for (const baseline of publishedBaselines) {
      const result = diffToolContract(baseline, liveManifest);
      expect(
        result.breaking,
        "MCP contract breaks a published baseline; follow docs/tool-contract-versioning.md",
      ).toEqual([]);
      expect(result.compatible).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("matches the latest generated baseline", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const liveManifest = normalizeManifest(
      await generateToolManifest(undefined, fetchMock),
    );

    expect(
      liveManifest,
      "MCP tool contract drifted; run `pnpm contract:generate` and review the generated diff",
    ).toEqual(normalizeManifest(committedManifest));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("contains only SPEC-governed tools and input properties", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const liveManifest = await generateToolManifest(undefined, fetchMock);
    const emptyBaseline: ToolContractManifest = {
      manifestVersion: liveManifest.manifestVersion,
      tools: [],
    };
    const result = diffToolContract(emptyBaseline, liveManifest);

    expect(
      result.breaking.filter(({ kind }) => kind.startsWith("ungoverned-")),
    ).toEqual([]);
    expect(liveManifest.tools.every((tool) =>
      SPEC_TOOL_CATALOGUE.includes(
        tool.name as (typeof SPEC_TOOL_CATALOGUE)[number],
      ),
    )).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("diffToolContract compatible additions", () => {
  it("accepts a new optional property governed for the tool", () => {
    const baseline: ToolContractManifest = {
      manifestVersion: 1,
      tools: [
        {
          name: "create_task",
          inputSchema: {
            type: "object",
            properties: { description: { type: "string" } },
            required: ["description"],
          },
        },
      ],
    };
    const candidate = replaceSchema(baseline, "create_task", {
      type: "object",
      properties: {
        description: { type: "string" },
        title: { type: "string" },
      },
      required: ["description"],
    });

    const result = diffToolContract(baseline, candidate);

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

  it("accepts an exclusive lower bound becoming inclusive", () => {
    const baseline = replaceSchema(
      committedManifest,
      "read_project_settings",
      settingsSchema({ type: "number", exclusiveMinimum: 0 }),
    );
    const candidate = replaceSchema(
      baseline,
      "read_project_settings",
      settingsSchema({ type: "number", minimum: 0 }),
    );

    const result = diffToolContract(baseline, candidate);

    expect(result.compatible).toBe(true);
    expect(result.breaking).toEqual([]);
    expect(result.additive).toContainEqual(
      expect.objectContaining({ kind: "constraint-loosened" }),
    );
  });

  it("accepts a new tool from the SPEC catalogue", () => {
    const candidate: ToolContractManifest = {
      ...committedManifest,
      tools: [
        ...committedManifest.tools,
        {
          name: "create_task",
          inputSchema: {
            type: "object",
            properties: { description: { type: "string" } },
            required: ["description"],
          },
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
  it("rejects a removed stable error code", () => {
    const errorContract = requiredErrorContract(committedManifest);
    const candidate: ToolContractManifest = {
      ...committedManifest,
      errorContract: {
        ...errorContract,
        codes: errorContract.codes.filter(({ code }) => code !== "internal"),
      },
    };

    expectBreaking(committedManifest, candidate, "error-code-removed");
  });

  it("rejects a changed stable error-code meaning", () => {
    const errorContract = requiredErrorContract(committedManifest);
    const candidate: ToolContractManifest = {
      ...committedManifest,
      errorContract: {
        ...errorContract,
        codes: errorContract.codes.map((entry) =>
          entry.code === "timeout"
            ? { ...entry, meaning: "some other failure" }
            : entry,
        ),
      },
    };

    expectBreaking(committedManifest, candidate, "error-code-meaning-changed");
  });

  it("rejects an incompatible canonical envelope change", () => {
    const errorContract = requiredErrorContract(committedManifest);
    const candidate: ToolContractManifest = {
      ...committedManifest,
      errorContract: { ...errorContract, isError: false },
    };

    expectBreaking(committedManifest, candidate, "error-contract-changed");
  });

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

  it("rejects an inclusive lower bound becoming exclusive", () => {
    const baseline = replaceSchema(
      committedManifest,
      "read_project_settings",
      settingsSchema({ type: "number", minimum: 0 }),
    );
    const candidate = replaceSchema(
      baseline,
      "read_project_settings",
      settingsSchema({ type: "number", exclusiveMinimum: 0 }),
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

  it("rejects an input property not governed for its tool", () => {
    const candidate = replaceSchema(committedManifest, "read_project_settings", {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        region: { type: "string" },
      },
    });

    expectBreaking(committedManifest, candidate, "ungoverned-property");
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

describe("published baseline history", () => {
  it("appends governed additive contracts without overwriting the old baseline", () => {
    const baseline: ToolContractManifest = {
      manifestVersion: 1,
      tools: [
        {
          name: "create_task",
          inputSchema: {
            type: "object",
            properties: { description: { type: "string" } },
            required: ["description"],
          },
        },
      ],
    };
    const artifact = updateToolContractArtifact(undefined, baseline, 1);
    const candidate = replaceSchema(baseline, "create_task", {
      type: "object",
      properties: {
        description: { type: "string" },
        title: { type: "string" },
      },
      required: ["description"],
    });

    const updated = updateToolContractArtifact(artifact, candidate, 1);

    expect(updated.baselines).toHaveLength(2);
    expect(updated.baselines[0]?.tools[0]?.inputSchema).toEqual(
      baseline.tools[0]?.inputSchema,
    );
    expect(updated.baselines[1]?.tools[0]?.inputSchema).toEqual(
      candidate.tools[0]?.inputSchema,
    );
  });

  it("refuses to overwrite a same-major baseline with a breaking contract", () => {
    const artifact = updateToolContractArtifact(
      undefined,
      committedManifest,
      currentPackageMajor,
    );
    const candidate: ToolContractManifest = {
      ...committedManifest,
      tools: committedManifest.tools.filter(
        ({ name }) => name !== "read_project_settings",
      ),
    };

    expect(() =>
      updateToolContractArtifact(artifact, candidate, currentPackageMajor),
    ).toThrow(/Bump the package major/u);
  });

  it("preserves and rejects incompatible manifest-version history", () => {
    const artifact = updateToolContractArtifact(
      undefined,
      committedManifest,
      currentPackageMajor,
    );
    const candidate: ToolContractManifest = {
      ...committedManifest,
      manifestVersion: committedManifest.manifestVersion + 1,
    };

    expect(artifact.baselines[0]?.manifestVersion).toBe(
      committedManifest.manifestVersion,
    );
    expect(() =>
      updateToolContractArtifact(artifact, candidate, currentPackageMajor),
    ).toThrow(/manifest-version-changed/u);
  });

  it("refuses to overwrite a same-major error contract baseline", () => {
    const artifact = updateToolContractArtifact(
      undefined,
      committedManifest,
      currentPackageMajor,
    );
    const errorContract = requiredErrorContract(committedManifest);
    const candidate: ToolContractManifest = {
      ...committedManifest,
      errorContract: {
        ...errorContract,
        codes: errorContract.codes.filter(({ code }) => code !== "timeout"),
      },
    };

    expect(() =>
      updateToolContractArtifact(artifact, candidate, currentPackageMajor),
    ).toThrow(/Bump the package major/u);
  });

  it("starts a new baseline history only after an explicit major bump", () => {
    const artifact = updateToolContractArtifact(
      undefined,
      committedManifest,
      currentPackageMajor,
    );
    const candidate: ToolContractManifest = {
      ...committedManifest,
      tools: committedManifest.tools.filter(
        ({ name }) => name !== "read_project_settings",
      ),
    };

    const updated = updateToolContractArtifact(
      artifact,
      candidate,
      currentPackageMajor + 1,
    );

    expect(updated.baselines.map(({ packageMajor }) => packageMajor)).toEqual([
      currentPackageMajor,
      currentPackageMajor + 1,
    ]);
  });

  it("rejects governance violations even after a major bump", () => {
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

    expect(() =>
      updateToolContractArtifact(
        committedArtifact,
        candidate,
        currentPackageMajor + 1,
      ),
    ).toThrow(/violates SPEC governance/u);
  });
});
