import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  generateToolManifest,
  packageMajor,
  type ToolContractArtifact,
  type ToolContractManifest,
  updateToolContractArtifact,
} from "../src/tool-contract.js";

interface PackageJson {
  version: string;
}

const outputPath = fileURLToPath(
  new URL("../tool-contract.json", import.meta.url),
);
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

async function readExistingContract(): Promise<
  ToolContractArtifact | ToolContractManifest | undefined
> {
  try {
    return JSON.parse(await readFile(outputPath, "utf8")) as
      ToolContractArtifact | ToolContractManifest;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

const packageJson = JSON.parse(
  await readFile(packagePath, "utf8"),
) as PackageJson;
const existing = await readExistingContract();
const liveManifest = await generateToolManifest();
const artifact = updateToolContractArtifact(
  existing,
  liveManifest,
  packageMajor(packageJson.version),
);

await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
process.stderr.write(`Wrote ${outputPath}\n`);
