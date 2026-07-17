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
