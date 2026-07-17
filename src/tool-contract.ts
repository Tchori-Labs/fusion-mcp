import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseConfig, type Config } from "./config.js";
import type { FetchLike } from "./fusion-client.js";
import { buildServer } from "./index.js";

export const TOOL_CONTRACT_MANIFEST_VERSION = 1 as const;

// Governance allowlist: update only together with the Tool catalogue in SPEC.md.
export const SPEC_TOOL_CATALOGUE = [
  "get_board_health",
  "list_projects",
  "list_tasks",
  "get_task",
  "get_task_logs",
  "get_task_workflow_results",
  "read_project_settings",
  "create_task",
  "comment_task",
  "steer_task",
  "pause_task",
  "unpause_task",
] as const;

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolContractEntry {
  name: string;
  inputSchema: JsonSchema;
}

export interface ToolContractManifest {
  manifestVersion: typeof TOOL_CONTRACT_MANIFEST_VERSION;
  tools: readonly ToolContractEntry[];
}

export type ContractChangeKind =
  | "manifest-version-changed"
  | "tool-removed"
  | "tool-added"
  | "ungoverned-tool"
  | "property-removed"
  | "property-added"
  | "required-added"
  | "required-removed"
  | "type-changed"
  | "format-changed"
  | "constraint-tightened"
  | "constraint-loosened"
  | "schema-changed";

export interface ContractChange {
  kind: ContractChangeKind;
  tool: string;
  path: string;
  message: string;
}

export interface ToolContractDiff {
  compatible: boolean;
  breaking: ContractChange[];
  additive: ContractChange[];
}

const rejectNetworkFetch: FetchLike = async () => {
  throw new Error("tool contract generation must not access the network");
};

export async function generateToolManifest(
  config: Config = parseConfig({}),
): Promise<ToolContractManifest> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(config, { fetch: rejectNetworkFetch });
  const client = new Client({
    name: "fusion-mcp-tool-contract",
    version: "1.0.0",
  });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();

    return {
      manifestVersion: TOOL_CONTRACT_MANIFEST_VERSION,
      tools: tools.map(({ name, inputSchema }) => ({ name, inputSchema })),
    };
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$schema")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeValue(child)]),
  );
}

export function normalizeManifest(
  manifest: ToolContractManifest,
): ToolContractManifest {
  return {
    manifestVersion: TOOL_CONTRACT_MANIFEST_VERSION,
    tools: [...manifest.tools]
      .map((tool) => ({
        name: tool.name,
        inputSchema: normalizeValue(tool.inputSchema) as JsonSchema,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
}

function stableValue(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}

function change(
  kind: ContractChangeKind,
  tool: string,
  path: string,
  message: string,
): ContractChange {
  return { kind, tool, path, message };
}

const LOWER_BOUND_KEYS = ["minimum", "minLength", "minItems"] as const;
const UPPER_BOUND_KEYS = ["maximum", "maxLength", "maxItems"] as const;
const HANDLED_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "properties",
  "required",
  "enum",
  "pattern",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "items",
  "additionalProperties",
]);

function compareBound(
  key: string,
  direction: "lower" | "upper",
  baseline: Record<string, unknown>,
  candidate: Record<string, unknown>,
  tool: string,
  path: string,
  result: ToolContractDiff,
): void {
  const before = baseline[key];
  const after = candidate[key];
  if (before === after) return;

  const isTighter =
    typeof after === "number" &&
    (typeof before !== "number" ||
      (direction === "lower" ? after > before : after < before));
  const isLooser =
    after === undefined ||
    (typeof before === "number" &&
      typeof after === "number" &&
      (direction === "lower" ? after < before : after > before));
  const target = isTighter
    ? result.breaking
    : isLooser
      ? result.additive
      : result.breaking;
  const kind = isTighter ? "constraint-tightened" : "constraint-loosened";

  target.push(
    change(
      isLooser || isTighter ? kind : "schema-changed",
      tool,
      `${path}.${key}`,
      `${key} changed from ${String(before)} to ${String(after)}`,
    ),
  );
}

function compareEnum(
  baseline: unknown,
  candidate: unknown,
  tool: string,
  path: string,
  result: ToolContractDiff,
): void {
  if (stableValue(baseline) === stableValue(candidate)) return;
  if (!Array.isArray(baseline) && Array.isArray(candidate)) {
    result.breaking.push(
      change("constraint-tightened", tool, path, "enum constraint was added"),
    );
    return;
  }
  if (Array.isArray(baseline) && !Array.isArray(candidate)) {
    result.additive.push(
      change("constraint-loosened", tool, path, "enum constraint was removed"),
    );
    return;
  }
  if (!Array.isArray(baseline) || !Array.isArray(candidate)) {
    result.breaking.push(
      change("schema-changed", tool, path, "enum schema changed"),
    );
    return;
  }

  const before = new Set(baseline.map(stableValue));
  const after = new Set(candidate.map(stableValue));
  const removed = [...before].some((value) => !after.has(value));
  const added = [...after].some((value) => !before.has(value));
  const target = removed ? result.breaking : result.additive;
  target.push(
    change(
      removed ? "constraint-tightened" : "constraint-loosened",
      tool,
      path,
      removed && added
        ? "enum values changed"
        : removed
          ? "enum values were narrowed"
          : "enum values were widened",
    ),
  );
}

function compareAdditionalProperties(
  baseline: unknown,
  candidate: unknown,
  tool: string,
  path: string,
  result: ToolContractDiff,
): void {
  if (stableValue(baseline) === stableValue(candidate)) return;
  if (candidate === false && baseline !== false) {
    result.breaking.push(
      change(
        "constraint-tightened",
        tool,
        path,
        "additional properties are no longer accepted",
      ),
    );
    return;
  }
  if (baseline === false && candidate !== false) {
    result.additive.push(
      change(
        "constraint-loosened",
        tool,
        path,
        "additional properties are now accepted",
      ),
    );
    return;
  }
  result.breaking.push(
    change("schema-changed", tool, path, "additionalProperties changed"),
  );
}

function compareSchema(
  baseline: JsonSchema,
  candidate: JsonSchema,
  tool: string,
  path: string,
  result: ToolContractDiff,
): void {
  for (const key of ["type", "format"] as const) {
    if (stableValue(baseline[key]) !== stableValue(candidate[key])) {
      result.breaking.push(
        change(
          key === "type" ? "type-changed" : "format-changed",
          tool,
          `${path}.${key}`,
          `${key} changed`,
        ),
      );
    }
  }

  const baselineProperties = asRecord(baseline.properties) ?? {};
  const candidateProperties = asRecord(candidate.properties) ?? {};
  const baselineRequired = stringSet(baseline.required);
  const candidateRequired = stringSet(candidate.required);

  for (const propertyName of Object.keys(baselineProperties)) {
    const propertyPath = `${path}.properties.${propertyName}`;
    if (!(propertyName in candidateProperties)) {
      result.breaking.push(
        change(
          "property-removed",
          tool,
          propertyPath,
          `property ${propertyName} was removed`,
        ),
      );
      continue;
    }
    const before = asRecord(baselineProperties[propertyName]);
    const after = asRecord(candidateProperties[propertyName]);
    if (before === undefined || after === undefined) {
      if (stableValue(before) !== stableValue(after)) {
        result.breaking.push(
          change("schema-changed", tool, propertyPath, "property schema changed"),
        );
      }
    } else {
      compareSchema(before, after, tool, propertyPath, result);
    }
  }

  for (const propertyName of Object.keys(candidateProperties)) {
    if (
      !(propertyName in baselineProperties) &&
      !candidateRequired.has(propertyName)
    ) {
      result.additive.push(
        change(
          "property-added",
          tool,
          `${path}.properties.${propertyName}`,
          `optional property ${propertyName} was added`,
        ),
      );
    }
  }

  for (const requiredName of candidateRequired) {
    if (!baselineRequired.has(requiredName)) {
      result.breaking.push(
        change(
          "required-added",
          tool,
          `${path}.required`,
          `property ${requiredName} became required`,
        ),
      );
    }
  }
  for (const requiredName of baselineRequired) {
    if (!candidateRequired.has(requiredName)) {
      result.additive.push(
        change(
          "required-removed",
          tool,
          `${path}.required`,
          `property ${requiredName} became optional`,
        ),
      );
    }
  }

  for (const key of LOWER_BOUND_KEYS) {
    compareBound(key, "lower", baseline, candidate, tool, path, result);
  }
  for (const key of UPPER_BOUND_KEYS) {
    compareBound(key, "upper", baseline, candidate, tool, path, result);
  }

  if (baseline.pattern !== candidate.pattern) {
    const removed = candidate.pattern === undefined;
    (removed ? result.additive : result.breaking).push(
      change(
        removed ? "constraint-loosened" : "constraint-tightened",
        tool,
        `${path}.pattern`,
        removed ? "pattern constraint was removed" : "pattern constraint changed",
      ),
    );
  }

  compareEnum(baseline.enum, candidate.enum, tool, `${path}.enum`, result);
  compareAdditionalProperties(
    baseline.additionalProperties,
    candidate.additionalProperties,
    tool,
    `${path}.additionalProperties`,
    result,
  );

  const baselineItems = asRecord(baseline.items);
  const candidateItems = asRecord(candidate.items);
  if (baselineItems !== undefined && candidateItems !== undefined) {
    compareSchema(baselineItems, candidateItems, tool, `${path}.items`, result);
  } else if (stableValue(baseline.items) !== stableValue(candidate.items)) {
    result.breaking.push(
      change("schema-changed", tool, `${path}.items`, "array item schema changed"),
    );
  }

  const unknownKeys = new Set([
    ...Object.keys(baseline),
    ...Object.keys(candidate),
  ]);
  for (const key of unknownKeys) {
    if (
      !HANDLED_SCHEMA_KEYS.has(key) &&
      stableValue(baseline[key]) !== stableValue(candidate[key])
    ) {
      result.breaking.push(
        change(
          "schema-changed",
          tool,
          `${path}.${key}`,
          `schema keyword ${key} changed`,
        ),
      );
    }
  }
}

export function diffToolContract(
  baseline: ToolContractManifest,
  candidate: ToolContractManifest,
): ToolContractDiff {
  const result: ToolContractDiff = {
    compatible: true,
    breaking: [],
    additive: [],
  };
  const governedNames = new Set<string>(SPEC_TOOL_CATALOGUE);
  const baselineByName = new Map(baseline.tools.map((tool) => [tool.name, tool]));
  const candidateByName = new Map(candidate.tools.map((tool) => [tool.name, tool]));

  if (baseline.manifestVersion !== candidate.manifestVersion) {
    result.breaking.push(
      change(
        "manifest-version-changed",
        "*",
        "manifestVersion",
        "manifest format version changed",
      ),
    );
  }

  for (const tool of candidate.tools) {
    if (!governedNames.has(tool.name)) {
      result.breaking.push(
        change(
          "ungoverned-tool",
          tool.name,
          `tools.${tool.name}`,
          `tool ${tool.name} is not in the SPEC catalogue`,
        ),
      );
    }
  }

  for (const [name, baselineTool] of baselineByName) {
    const candidateTool = candidateByName.get(name);
    if (candidateTool === undefined) {
      result.breaking.push(
        change(
          "tool-removed",
          name,
          `tools.${name}`,
          `tool ${name} was removed or renamed`,
        ),
      );
      continue;
    }
    compareSchema(
      baselineTool.inputSchema,
      candidateTool.inputSchema,
      name,
      `tools.${name}.inputSchema`,
      result,
    );
  }

  for (const [name] of candidateByName) {
    if (!baselineByName.has(name) && governedNames.has(name)) {
      result.additive.push(
        change(
          "tool-added",
          name,
          `tools.${name}`,
          `governed tool ${name} was added`,
        ),
      );
    }
  }

  result.compatible = result.breaking.length === 0;
  return result;
}
