import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runValidationCauseCli } from "../src/validation-cause.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let input = "";
  return new Promise((resolve, reject) => {
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

process.exitCode = await runValidationCauseCli(process.argv.slice(2), {
  readFile: (path) => readFile(path, "utf8"),
  readStdin,
  repositoryRoot,
  writeOut: (text) => process.stdout.write(text),
  writeErr: (text) => process.stderr.write(text),
});
