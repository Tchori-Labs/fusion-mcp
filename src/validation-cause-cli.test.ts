import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  EXIT_CLASSIFIED,
  EXIT_CLEAR,
  EXIT_USAGE_OR_IO,
  extractDescriptionFromTaskJson,
  parseCliArguments,
  runValidationCauseCli,
  taskDescriptionPath,
  type ValidationCauseCliIo,
} from "./validation-cause.js";

const synthesizedCause = `## Validation cause
Source feature: F-1
Validator run: VR-1
Failed assertions: CA-1
### CA-1 (fail)
Details: Validator omitted linked assertion result.`;
const substantiveCause = `## Validation cause
Source feature: F-1
Validator run: VR-1
Failed assertions: CA-1
### CA-1 (fail)
Expected: safe
Observed: unsafe
Details: Real finding.`;

function fakeIo(overrides: Partial<ValidationCauseCliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: ValidationCauseCliIo = {
    readFile: vi.fn(async () => synthesizedCause),
    readStdin: vi.fn(async () => synthesizedCause),
    repositoryRoot: "/repo",
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
    ...overrides,
  };
  return { io, out, err };
}

describe("validation-cause CLI argument and JSON contracts", () => {
  it("parses --file mode", () => {
    expect(parseCliArguments(["--file", "cause.txt"])).toEqual({
      mode: "file",
      path: "cause.txt",
    });
  });

  it("parses --task mode", () => {
    expect(parseCliArguments(["--task", "KB-123"])).toEqual({
      mode: "task",
      taskId: "KB-123",
    });
  });

  it("parses no arguments as stdin mode", () => {
    expect(parseCliArguments([])).toEqual({ mode: "stdin" });
  });

  it.each([
    [["--unknown"], "Unknown argument"],
    [["--file"], "Missing value"],
    [["--file", "a", "--task", "KB-1"], "exactly one input mode"],
  ])("rejects invalid arguments %#", (argv, message) => {
    const parsed = parseCliArguments(argv);
    expect(parsed.mode).toBe("usage-error");
    expect(parsed).toMatchObject({ message: expect.stringContaining(message) });
  });

  it("composes the documented task artifact path", () => {
    expect(taskDescriptionPath("/repo/", "KB-123")).toBe(
      "/repo/.fusion/tasks/KB-123/task.json",
    );
  });

  it.each([
    ["malformed JSON", "{", "malformed JSON"],
    ["non-object root", "[]", "root must be an object"],
    ["missing description", "{}", "missing the top-level description"],
    ["non-string description", '{"description":42}', "must be a string"],
  ])("rejects task artifact with %s", (_name, raw, message) => {
    expect(extractDescriptionFromTaskJson(raw)).toEqual({
      ok: false,
      message: expect.stringContaining(message),
    });
  });

  it("extracts a top-level string description", () => {
    expect(
      extractDescriptionFromTaskJson('{"description":"cause text"}'),
    ).toEqual({ ok: true, description: "cause text" });
  });
});

describe("injectable validation-cause CLI orchestration", () => {
  it("reads --file and returns classified exit 2 for a synthesized cause", async () => {
    const harness = fakeIo();
    await expect(
      runValidationCauseCli(["--file", "cause.txt"], harness.io),
    ).resolves.toBe(EXIT_CLASSIFIED);
    expect(harness.io.readFile).toHaveBeenCalledWith("cause.txt");
    expect(harness.out.join("")).toContain("Classification: non-substantive");
    expect(harness.err).toEqual([]);
  });

  it("returns clear exit 0 for a substantive cause", async () => {
    const harness = fakeIo({ readFile: vi.fn(async () => substantiveCause) });
    await expect(
      runValidationCauseCli(["--file", "cause.txt"], harness.io),
    ).resolves.toBe(EXIT_CLEAR);
    expect(harness.out.join("")).toContain("Classification: substantive");
  });

  it("reads stdin through the injected capability", async () => {
    const harness = fakeIo();
    await expect(runValidationCauseCli([], harness.io)).resolves.toBe(
      EXIT_CLASSIFIED,
    );
    expect(harness.io.readStdin).toHaveBeenCalledOnce();
  });

  it("returns usage/IO exit 1 for an unknown flag", async () => {
    const harness = fakeIo();
    await expect(
      runValidationCauseCli(["--unknown"], harness.io),
    ).resolves.toBe(EXIT_USAGE_OR_IO);
    expect(harness.err.join("")).toContain("Unknown argument");
  });

  it("returns usage/IO exit 1 for a missing flag value", async () => {
    const harness = fakeIo();
    await expect(runValidationCauseCli(["--file"], harness.io)).resolves.toBe(
      EXIT_USAGE_OR_IO,
    );
    expect(harness.err.join("")).toContain("Missing value");
  });

  it("returns usage/IO exit 1 for conflicting input modes", async () => {
    const harness = fakeIo();
    await expect(
      runValidationCauseCli(["--file", "a", "--task", "KB-1"], harness.io),
    ).resolves.toBe(EXIT_USAGE_OR_IO);
    expect(harness.err.join("")).toContain("exactly one input mode");
  });

  it("handles a missing --file read without rethrowing", async () => {
    const error = Object.assign(new Error("secret detail"), { code: "ENOENT" });
    const harness = fakeIo({
      readFile: vi.fn(async () => Promise.reject(error)),
    });
    await expect(
      runValidationCauseCli(["--file", "missing.txt"], harness.io),
    ).resolves.toBe(EXIT_USAGE_OR_IO);
    expect(harness.err.join("")).toContain("does not exist: missing.txt");
    expect(harness.err.join("")).not.toContain("secret detail");
  });

  it("handles an unreadable EACCES file with a distinct message", async () => {
    const error = Object.assign(new Error("private"), { code: "EACCES" });
    const harness = fakeIo({
      readFile: vi.fn(async () => Promise.reject(error)),
    });
    await expect(
      runValidationCauseCli(["--file", "locked.txt"], harness.io),
    ).resolves.toBe(EXIT_USAGE_OR_IO);
    expect(harness.err.join("")).toContain("not readable: locked.txt");
    expect(harness.err.join("")).not.toContain("private");
  });

  it("handles a generic file read rejection without leaking it", async () => {
    const harness = fakeIo({
      readFile: vi.fn(async () => Promise.reject(new Error("token=hidden"))),
    });
    await expect(
      runValidationCauseCli(["--file", "cause.txt"], harness.io),
    ).resolves.toBe(EXIT_USAGE_OR_IO);
    expect(harness.err.join("")).toContain("Could not read input");
    expect(harness.err.join("")).not.toContain("token=hidden");
  });

  it("handles a rejected stdin read", async () => {
    const harness = fakeIo({
      readStdin: vi.fn(async () => Promise.reject(new Error("secret"))),
    });
    await expect(runValidationCauseCli([], harness.io)).resolves.toBe(
      EXIT_USAGE_OR_IO,
    );
    expect(harness.err.join("")).toContain("from stdin");
    expect(harness.err.join("")).not.toContain("secret");
  });

  it("guides absent --task artifacts around gitignored .fusion", async () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    const harness = fakeIo({
      readFile: vi.fn(async () => Promise.reject(error)),
    });
    await expect(
      runValidationCauseCli(["--task", "KB-123"], harness.io),
    ).resolves.toBe(EXIT_USAGE_OR_IO);
    expect(harness.err.join("")).toContain(".fusion directory is gitignored");
    expect(harness.err.join("")).toContain("use --file or stdin");
  });

  it.each([
    ["malformed JSON", "{", "malformed JSON"],
    ["a non-object root", "null", "root must be an object"],
    ["a missing description", "{}", "missing the top-level description"],
    ["a non-string description", '{"description":false}', "must be a string"],
  ])("handles task artifact containing %s", async (_name, raw, message) => {
    const harness = fakeIo({ readFile: vi.fn(async () => raw) });
    await expect(
      runValidationCauseCli(["--task", "KB-123"], harness.io),
    ).resolves.toBe(EXIT_USAGE_OR_IO);
    expect(harness.err.join("")).toContain(message);
  });

  it("round-trips real filesystem task reads and reports a missing artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "validation-cause-"));
    try {
      const taskDirectory = join(directory, ".fusion", "tasks", "KB-123");
      await mkdir(taskDirectory, { recursive: true });
      await writeFile(
        join(taskDirectory, "task.json"),
        JSON.stringify({ description: synthesizedCause }),
        "utf8",
      );
      const existing = fakeIo({
        readFile: (path) => readFile(path, "utf8"),
        repositoryRoot: directory,
      });
      await expect(
        runValidationCauseCli(["--task", "KB-123"], existing.io),
      ).resolves.toBe(EXIT_CLASSIFIED);
      expect(existing.out.join("")).toContain(
        "Classification: non-substantive",
      );

      const missing = fakeIo({
        readFile: (path) => readFile(path, "utf8"),
        repositoryRoot: directory,
      });
      await expect(
        runValidationCauseCli(["--task", "KB-404"], missing.io),
      ).resolves.toBe(EXIT_USAGE_OR_IO);
      expect(missing.err.join("")).toContain(".fusion directory is gitignored");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
