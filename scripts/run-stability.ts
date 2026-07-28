import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DEFAULT_ITERATIONS = 10;
const RESULTS_DIRECTORY = "stability-results";
const ITERATION_ENVIRONMENT_VARIABLE = "FUSION_MCP_STABILITY_ITERATIONS";

export interface StabilityBurnInOptions {
  iterations: number;
  runIteration: (iteration: number) => number;
  log: (line: string) => void;
}

export interface StabilityBurnInResult {
  failedIteration: number | null;
  completedIterations: number;
}

export function parseIterationCount(raw: string | undefined): number {
  const value = raw?.trim();
  if (value === undefined || value === "") {
    return DEFAULT_ITERATIONS;
  }

  if (!/^\d+$/u.test(value)) {
    throw new Error(
      `${ITERATION_ENVIRONMENT_VARIABLE} must be a positive integer; received ${JSON.stringify(raw)}`,
    );
  }

  const iterations = Number(value);
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new Error(
      `${ITERATION_ENVIRONMENT_VARIABLE} must be a positive integer; received ${JSON.stringify(raw)}`,
    );
  }

  return iterations;
}

export function buildIterationArgs(iteration: number): string[] {
  return [
    "exec",
    "vitest",
    "run",
    "--retry=0",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${RESULTS_DIRECTORY}/iteration-${iteration}.json`,
  ];
}

export function runStabilityBurnIn({
  iterations,
  runIteration,
  log,
}: StabilityBurnInOptions): StabilityBurnInResult {
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    log(`[stability] iteration ${iteration}/${iterations} starting`);
    const exitCode = runIteration(iteration);

    if (exitCode !== 0) {
      log(
        `[stability] iteration ${iteration}/${iterations} failed (exit ${exitCode})`,
      );
      return {
        failedIteration: iteration,
        completedIterations: iteration,
      };
    }

    log(`[stability] iteration ${iteration}/${iterations} passed (exit 0)`);
  }

  return {
    failedIteration: null,
    completedIterations: iterations,
  };
}

function main(): void {
  const iterations = parseIterationCount(
    process.env[ITERATION_ENVIRONMENT_VARIABLE],
  );
  mkdirSync(RESULTS_DIRECTORY, { recursive: true });

  const result = runStabilityBurnIn({
    iterations,
    log: (line) => console.log(line),
    runIteration: (iteration) => {
      const child = spawnSync("pnpm", buildIterationArgs(iteration), {
        stdio: "inherit",
      });
      return child.status ?? 1;
    },
  });

  if (result.failedIteration !== null) {
    console.error(
      `[stability] stopped at failing iteration ${result.failedIteration}/${iterations}; inspect ${RESULTS_DIRECTORY}/iteration-${result.failedIteration}.json`,
    );
    process.exit(1);
  }

  console.log(`[stability] all ${iterations} iterations passed`);
}

const modulePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === resolve(modulePath)) {
  main();
}
