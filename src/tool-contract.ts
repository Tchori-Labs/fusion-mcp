import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseConfig, type Config } from "./config.js";
import type { FetchLike } from "./fusion-client.js";
import { buildServer } from "./index.js";
import { TOOL_ERROR_CONTRACT } from "./tool-error.js";

export const TOOL_CONTRACT_MANIFEST_VERSION = 1 as const;
export const TOOL_CONTRACT_ARTIFACT_VERSION = 1 as const;

// Governance allowlist: update only together with the Tool catalogue in SPEC.md.
export const SPEC_TOOL_INPUT_PROPERTIES = {
  get_board_health: [],
  list_projects: [],
  list_tasks: [
    "projectId",
    "limit",
    "offset",
    "q",
    "column",
    "includeArchived",
  ],
  get_task: ["id", "projectId"],
  get_task_logs: ["id", "limit", "offset"],
  get_task_workflow_results: ["id"],
  read_project_settings: ["projectId"],
  create_task: [
    "description",
    "title",
    "column",
    "priority",
    "dependencies",
    "workflowId",
    "baseBranch",
    "projectId",
  ],
  comment_task: ["id", "text", "author"],
  steer_task: ["id", "text"],
  pause_task: ["id"],
  unpause_task: ["id"],
} as const;

export const SPEC_TOOL_CATALOGUE = Object.freeze(
  Object.keys(SPEC_TOOL_INPUT_PROPERTIES) as Array<
    keyof typeof SPEC_TOOL_INPUT_PROPERTIES
  >,
);

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolContractEntry {
  name: string;
  inputSchema: JsonSchema;
}

export interface ToolErrorContractManifest {
  envelopeVersion: number;
  isError: boolean;
  contentType: string;
  textEncoding: string;
  requiredFields: readonly string[];
  optionalFields: readonly string[];
  codes: readonly { code: string; meaning: string }[];
  statusCodes: readonly string[];
  detailsExtensible: boolean;
}

export interface ToolContractManifest {
  manifestVersion: typeof TOOL_CONTRACT_MANIFEST_VERSION;
  errorContract?: ToolErrorContractManifest;
  tools: readonly ToolContractEntry[];
}

export interface PublishedToolContractBaseline extends ToolContractManifest {
  packageMajor: number;
}

export interface ToolContractArtifact {
  artifactVersion: typeof TOOL_CONTRACT_ARTIFACT_VERSION;
  baselines: readonly PublishedToolContractBaseline[];
}

export type ContractChangeKind =
  | "manifest-version-changed"
  | "error-contract-added"
  | "error-contract-removed"
  | "error-contract-changed"
  | "error-code-added"
  | "error-code-removed"
  | "error-code-meaning-changed"
  | "tool-removed"
  | "tool-added"
  | "ungoverned-tool"
  | "ungoverned-property"
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
  fetch: FetchLike = rejectNetworkFetch,
): Promise<ToolContractManifest> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(config, { fetch });
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
      errorContract: TOOL_ERROR_CONTRACT,
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
    ...(manifest.errorContract === undefined
      ? {}
      : {
          errorContract: normalizeValue(
            manifest.errorContract,
          ) as ToolErrorContractManifest,
        }),
    tools: [...manifest.tools]
      .map((tool) => ({
        name: tool.name,
        inputSchema: normalizeValue(tool.inputSchema) as JsonSchema,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function packageMajor(version: string): number {
  const match = /^(\d+)\./u.exec(version);
  if (match?.[1] === undefined) {
    throw new Error(`invalid package version: ${version}`);
  }
  return Number(match[1]);
}

function normalizeBaseline(
  baseline: PublishedToolContractBaseline,
): PublishedToolContractBaseline {
  return {
    packageMajor: baseline.packageMajor,
    ...normalizeManifest(baseline),
  };
}

function asArtifact(
  existing: ToolContractArtifact | ToolContractManifest | undefined,
  currentPackageMajor: number,
): ToolContractArtifact {
  if (existing === undefined) {
    return {
      artifactVersion: TOOL_CONTRACT_ARTIFACT_VERSION,
      baselines: [],
    };
  }
  if ("baselines" in existing) {
    return {
      artifactVersion: TOOL_CONTRACT_ARTIFACT_VERSION,
      baselines: existing.baselines.map(normalizeBaseline),
    };
  }
  return {
    artifactVersion: TOOL_CONTRACT_ARTIFACT_VERSION,
    baselines: [
      {
        packageMajor: currentPackageMajor,
        ...normalizeManifest(existing),
      },
    ],
  };
}

/**
 * Append a generated contract to the published baseline history.
 *
 * Baselines within the current package major are never overwritten, so CI can
 * compare the live surface with every contract published in that major. A
 * breaking contract starts a new history only after the package major changes.
 */
export function updateToolContractArtifact(
  existing: ToolContractArtifact | ToolContractManifest | undefined,
  candidate: ToolContractManifest,
  currentPackageMajor: number,
): ToolContractArtifact {
  const artifact = asArtifact(existing, currentPackageMajor);
  const normalizedCandidate = normalizeManifest(candidate);
  const greatestPublishedMajor = Math.max(
    -1,
    ...artifact.baselines.map((baseline) => baseline.packageMajor),
  );
  if (currentPackageMajor < greatestPublishedMajor) {
    throw new Error(
      `package major ${currentPackageMajor} is older than published contract major ${greatestPublishedMajor}`,
    );
  }

  const governanceCheck = diffToolContract(
    {
      manifestVersion: TOOL_CONTRACT_MANIFEST_VERSION,
      tools: [],
    },
    normalizedCandidate,
  );
  const governanceViolations = governanceCheck.breaking.filter(
    ({ kind }) => kind === "ungoverned-tool" || kind === "ungoverned-property",
  );
  if (governanceViolations.length > 0) {
    throw new Error(
      `tool contract violates SPEC governance:\n${formatChanges(governanceViolations)}`,
    );
  }

  const activeBaselines = artifact.baselines.filter(
    (baseline) => baseline.packageMajor === currentPackageMajor,
  );
  for (const baseline of activeBaselines) {
    const result = diffToolContract(baseline, normalizedCandidate);
    if (!result.compatible) {
      throw new Error(
        `breaking tool contract change in package major ${currentPackageMajor}:\n${formatChanges(result.breaking)}\nBump the package major and follow docs/tool-contract-versioning.md before regenerating.`,
      );
    }
  }

  const latest = activeBaselines.at(-1);
  if (
    latest !== undefined &&
    JSON.stringify(normalizeManifest(latest)) ===
      JSON.stringify(normalizedCandidate)
  ) {
    return artifact;
  }

  return {
    artifactVersion: TOOL_CONTRACT_ARTIFACT_VERSION,
    baselines: [
      ...artifact.baselines,
      {
        packageMajor: currentPackageMajor,
        ...normalizedCandidate,
      },
    ],
  };
}

function formatChanges(changes: readonly ContractChange[]): string {
  return changes
    .map(({ kind, path, message }) => `- ${kind} at ${path}: ${message}`)
    .join("\n");
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

function compareErrorContract(
  baseline: ToolErrorContractManifest | undefined,
  candidate: ToolErrorContractManifest | undefined,
  result: ToolContractDiff,
): void {
  if (baseline === undefined) {
    if (candidate !== undefined) {
      result.additive.push(
        change(
          "error-contract-added",
          "*",
          "errorContract",
          "canonical tool error contract was added",
        ),
      );
    }
    return;
  }
  if (candidate === undefined) {
    result.breaking.push(
      change(
        "error-contract-removed",
        "*",
        "errorContract",
        "canonical tool error contract was removed",
      ),
    );
    return;
  }

  const { codes: baselineCodes, ...baselineEnvelope } = baseline;
  const { codes: candidateCodes, ...candidateEnvelope } = candidate;
  if (stableValue(baselineEnvelope) !== stableValue(candidateEnvelope)) {
    result.breaking.push(
      change(
        "error-contract-changed",
        "*",
        "errorContract",
        "canonical tool error envelope changed",
      ),
    );
  }

  const baselineByCode = new Map(
    baselineCodes.map(({ code, meaning }) => [code, meaning]),
  );
  const candidateByCode = new Map(
    candidateCodes.map(({ code, meaning }) => [code, meaning]),
  );
  if (
    baselineByCode.size !== baselineCodes.length ||
    candidateByCode.size !== candidateCodes.length
  ) {
    result.breaking.push(
      change(
        "error-contract-changed",
        "*",
        "errorContract.codes",
        "error code entries must be unique",
      ),
    );
  }

  for (const [code, meaning] of baselineByCode) {
    const candidateMeaning = candidateByCode.get(code);
    if (candidateMeaning === undefined) {
      result.breaking.push(
        change(
          "error-code-removed",
          "*",
          `errorContract.codes.${code}`,
          `error code ${code} was removed or renamed`,
        ),
      );
    } else if (candidateMeaning !== meaning) {
      result.breaking.push(
        change(
          "error-code-meaning-changed",
          "*",
          `errorContract.codes.${code}.meaning`,
          `meaning of error code ${code} changed`,
        ),
      );
    }
  }

  for (const [code] of candidateByCode) {
    if (!baselineByCode.has(code)) {
      result.additive.push(
        change(
          "error-code-added",
          "*",
          `errorContract.codes.${code}`,
          `error code ${code} was added`,
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

  compareErrorContract(baseline.errorContract, candidate.errorContract, result);

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
      continue;
    }

    const allowedProperties = new Set<string>(
      SPEC_TOOL_INPUT_PROPERTIES[
        tool.name as keyof typeof SPEC_TOOL_INPUT_PROPERTIES
      ],
    );
    const declaredProperties = Object.keys(
      asRecord(tool.inputSchema.properties) ?? {},
    );
    const requiredProperties = stringSet(tool.inputSchema.required);
    for (const propertyName of new Set([
      ...declaredProperties,
      ...requiredProperties,
    ])) {
      if (!allowedProperties.has(propertyName)) {
        result.breaking.push(
          change(
            "ungoverned-property",
            tool.name,
            `tools.${tool.name}.inputSchema.properties.${propertyName}`,
            `property ${propertyName} is not governed for tool ${tool.name} in SPEC.md`,
          ),
        );
      }
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
