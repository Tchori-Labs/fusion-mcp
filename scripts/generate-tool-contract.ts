import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  generateToolManifest,
  normalizeManifest,
} from "../src/tool-contract.js";

const outputPath = fileURLToPath(new URL("../tool-contract.json", import.meta.url));
const manifest = normalizeManifest(await generateToolManifest());

await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stderr.write(`Wrote ${outputPath}\n`);
