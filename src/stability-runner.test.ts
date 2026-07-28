import { describe, expect, it, vi } from "vitest";

import {
  buildIterationArgs,
  parseIterationCount,
  runStabilityBurnIn,
} from "../scripts/run-stability.js";

describe("stability burn-in runner", () => {
  it("accounts for all successful iterations in order", () => {
    const runIteration = vi.fn(() => 0);
    const log = vi.fn();

    const result = runStabilityBurnIn({
      iterations: 10,
      runIteration,
      log,
    });

    expect(runIteration.mock.calls).toEqual(
      Array.from({ length: 10 }, (_, index) => [index + 1]),
    );
    expect(result).toEqual({
      failedIteration: null,
      completedIterations: 10,
    });
  });

  it("propagates the first failure without retrying or continuing", () => {
    const runIteration = vi
      .fn<(iteration: number) => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1);
    const lines: string[] = [];

    const result = runStabilityBurnIn({
      iterations: 10,
      runIteration,
      log: (line) => lines.push(line),
    });

    expect(runIteration.mock.calls).toEqual([[1], [2], [3]]);
    expect(result).toEqual({ failedIteration: 3, completedIterations: 3 });
    expect(lines).toContain("[stability] iteration 3/10 failed (exit 1)");
    expect(lines).not.toContain("[stability] iteration 4/10 starting");
  });

  it("logs start context for every repetition", () => {
    const lines: string[] = [];

    runStabilityBurnIn({
      iterations: 3,
      runIteration: () => 0,
      log: (line) => lines.push(line),
    });

    expect(lines.filter((line) => line.endsWith("starting"))).toEqual([
      "[stability] iteration 1/3 starting",
      "[stability] iteration 2/3 starting",
      "[stability] iteration 3/3 starting",
    ]);
  });
});

describe("stability runner configuration", () => {
  it("parses the default and positive integer overrides", () => {
    expect(parseIterationCount(undefined)).toBe(10);
    expect(parseIterationCount("")).toBe(10);
    expect(parseIterationCount("3")).toBe(3);
  });

  it.each(["0", "-2", "1.5", "abc"])(
    "rejects invalid iteration count %j",
    (raw) => {
      expect(() => parseIterationCount(raw)).toThrow(/positive integer/u);
    },
  );

  it("builds hermetic Vitest arguments with retries disabled", () => {
    const args = buildIterationArgs(4);

    expect(args).toEqual([
      "exec",
      "vitest",
      "run",
      "--retry=0",
      "--reporter=default",
      "--reporter=json",
      "--outputFile.json=stability-results/iteration-4.json",
    ]);
    expect(args).not.toContain("vitest.live.config.ts");
    expect(args).not.toContain("--config");
  });
});
