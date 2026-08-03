export const SYNTHESIZED_VALIDATOR_MESSAGES = Object.freeze([
  "Validator omitted linked assertion result.",
  "Duplicate validator result for linked assertion.",
] as const);

// Independent completeness oracle: do not derive this from the message array.
export const EXPECTED_SYNTHESIZED_MESSAGE_COUNT = 2;

export const EXIT_CLEAR = 0;
export const EXIT_USAGE_OR_IO = 1;
export const EXIT_CLASSIFIED = 2;

export type ValidationCauseClassification =
  "none" | "substantive" | "mixed" | "non-substantive";

export interface ParsedValidationAssertion {
  assertionId: string;
  verdict: string;
  expected?: string;
  observed?: string;
  details?: string;
  evidence: string[];
  omittedEvidenceCount?: number;
  omittedEvidenceInvalid: boolean;
  synthesized: boolean;
}

export interface ParsedValidationCause {
  sourceFeature: string;
  runId: string;
  failedAssertionIds: string[];
  blockedAssertionIds: string[];
  assertions: ParsedValidationAssertion[];
}

export interface ValidationCauseReport {
  classification: ValidationCauseClassification;
  causes: ParsedValidationCause[];
  synthesizedAssertionIds: string[];
  substantiveAssertionIds: string[];
  runIds: string[];
}

function normalizeSynthesizedMessage(value: string): string {
  return value.trim().replace(/\s+/gu, " ").replace(/\.$/u, "").toLowerCase();
}

const NORMALIZED_SYNTHESIZED_MESSAGES = new Set(
  SYNTHESIZED_VALIDATOR_MESSAGES.map(normalizeSynthesizedMessage),
);

function parseIdList(value: string | undefined, fallback: string): string[] {
  if (value === undefined || value.trim().toLowerCase() === fallback) return [];
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function fieldValue(lines: string[], label: string): string | undefined {
  const prefix = `${label}:`;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

function parseAssertion(
  assertionId: string,
  verdict: string,
  lines: string[],
): ParsedValidationAssertion {
  const expected = fieldValue(lines, "Expected");
  const observed = fieldValue(lines, "Observed");
  const details = fieldValue(lines, "Details");
  const evidence = lines
    .filter((line) => line.startsWith("Evidence:"))
    .map((line) => line.slice("Evidence:".length).trim());
  const omittedRaw = fieldValue(lines, "Additional evidence omitted");
  const omittedEvidenceCount =
    omittedRaw !== undefined && /^\d+$/u.test(omittedRaw)
      ? Number(omittedRaw)
      : undefined;
  const omittedEvidenceInvalid =
    omittedRaw !== undefined && omittedEvidenceCount === undefined;
  const placeholder =
    details !== undefined &&
    NORMALIZED_SYNTHESIZED_MESSAGES.has(normalizeSynthesizedMessage(details));

  // Engine-synthesized fallbacks carry no evidence fields. A positive omitted
  // count proves real evidence existed and was truncated, so fail substantive.
  const synthesized =
    placeholder &&
    expected === undefined &&
    observed === undefined &&
    evidence.length === 0 &&
    !omittedEvidenceInvalid &&
    (omittedEvidenceCount === undefined || omittedEvidenceCount === 0);

  return {
    assertionId,
    verdict,
    ...(expected === undefined ? {} : { expected }),
    ...(observed === undefined ? {} : { observed }),
    ...(details === undefined ? {} : { details }),
    evidence,
    ...(omittedEvidenceCount === undefined ? {} : { omittedEvidenceCount }),
    omittedEvidenceInvalid,
    synthesized,
  };
}

function parseCauseBlock(lines: string[]): ParsedValidationCause {
  const firstAssertionIndex = lines.findIndex((line) => /^###\s+/u.test(line));
  const metadata = lines.slice(
    0,
    firstAssertionIndex === -1 ? lines.length : firstAssertionIndex,
  );
  const assertions: ParsedValidationAssertion[] = [];

  for (let index = firstAssertionIndex; index >= 0 && index < lines.length;) {
    const heading = /^###\s+(.+?)\s+\(([^)]+)\)\s*$/u.exec(lines[index] ?? "");
    if (heading === null) {
      index += 1;
      continue;
    }
    let next = index + 1;
    while (next < lines.length && !/^###\s+/u.test(lines[next] ?? ""))
      next += 1;
    assertions.push(
      parseAssertion(
        (heading[1] ?? "").trim(),
        (heading[2] ?? "").trim(),
        lines.slice(index + 1, next),
      ),
    );
    index = next;
  }

  return {
    sourceFeature: fieldValue(metadata, "Source feature") ?? "",
    runId: fieldValue(metadata, "Validator run") ?? "",
    failedAssertionIds: parseIdList(
      fieldValue(metadata, "Failed assertions"),
      "none recorded",
    ),
    blockedAssertionIds: parseIdList(
      fieldValue(metadata, "Blocked assertions"),
      "none recorded",
    ),
    assertions,
  };
}

export function parseValidationCauses(
  description: string,
): ParsedValidationCause[] {
  const lines = description.replace(/\r\n?/gu, "\n").split("\n");
  const causes: ParsedValidationCause[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "## Validation cause") continue;
    let end = index + 1;
    while (end < lines.length && lines[end]?.trim() !== "## Validation cause") {
      end += 1;
    }
    causes.push(parseCauseBlock(lines.slice(index + 1, end)));
    index = end - 1;
  }
  return causes;
}

export function classifyValidationCause(
  description: string,
): ValidationCauseReport {
  const causes = parseValidationCauses(description);
  const assertions = causes.flatMap((cause) => cause.assertions);
  const synthesizedAssertionIds = assertions
    .filter((assertion) => assertion.synthesized)
    .map((assertion) => assertion.assertionId);
  const substantiveAssertionIds = assertions
    .filter((assertion) => !assertion.synthesized)
    .map((assertion) => assertion.assertionId);

  let classification: ValidationCauseClassification;
  if (causes.length === 0) classification = "none";
  else if (synthesizedAssertionIds.length === 0) classification = "substantive";
  else if (substantiveAssertionIds.length === 0)
    classification = "non-substantive";
  else classification = "mixed";

  return {
    classification,
    causes,
    synthesizedAssertionIds,
    substantiveAssertionIds,
    runIds: [...new Set(causes.map((cause) => cause.runId).filter(Boolean))],
  };
}

export function formatValidationCauseReport(
  report: ValidationCauseReport,
): string {
  return [
    `Classification: ${report.classification}`,
    `Validator runs: ${report.runIds.join(", ") || "none"}`,
    `Synthesized assertions: ${report.synthesizedAssertionIds.join(", ") || "none"}`,
    `Substantive assertions: ${report.substantiveAssertionIds.join(", ") || "none"}`,
  ].join("\n");
}

export function exitCodeForValidationCause(
  report: ValidationCauseReport,
): number {
  return report.classification === "non-substantive" ||
    report.classification === "mixed"
    ? EXIT_CLASSIFIED
    : EXIT_CLEAR;
}

export type ValidationCauseCliArguments =
  | { mode: "file"; path: string }
  | { mode: "task"; taskId: string }
  | { mode: "stdin" }
  | { mode: "usage-error"; message: string };

export interface ValidationCauseCliIo {
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
  repositoryRoot: string;
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export function parseCliArguments(
  argv: readonly string[],
): ValidationCauseCliArguments {
  if (argv.length === 0) return { mode: "stdin" };

  let source: ValidationCauseCliArguments | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--file" && flag !== "--task") {
      return {
        mode: "usage-error",
        message: `Unknown argument: ${flag ?? ""}. Use --file <path>, --task <ID>, or stdin.`,
      };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return {
        mode: "usage-error",
        message: `Missing value for ${flag}.`,
      };
    }
    if (source !== undefined) {
      return {
        mode: "usage-error",
        message: "Choose exactly one input mode: --file, --task, or stdin.",
      };
    }
    source =
      flag === "--file"
        ? { mode: "file", path: value }
        : { mode: "task", taskId: value };
    index += 1;
  }
  return source ?? { mode: "stdin" };
}

export function taskDescriptionPath(
  repositoryRoot: string,
  taskId: string,
): string {
  return `${repositoryRoot.replace(/\/$/u, "")}/.fusion/tasks/${taskId}/task.json`;
}

export type TaskDescriptionResult =
  { ok: true; description: string } | { ok: false; message: string };

export function extractDescriptionFromTaskJson(
  rawJson: string,
): TaskDescriptionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch {
    return { ok: false, message: "Task artifact contains malformed JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: "Task artifact JSON root must be an object." };
  }
  if (!("description" in parsed)) {
    return {
      ok: false,
      message: "Task artifact is missing the top-level description key.",
    };
  }
  if (typeof parsed.description !== "string") {
    return {
      ok: false,
      message: "Task artifact description must be a string.",
    };
  }
  return { ok: true, description: parsed.description };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function writeCliError(io: ValidationCauseCliIo, message: string): number {
  io.writeErr(`${message}\n`);
  return EXIT_USAGE_OR_IO;
}

function readFailureMessage(
  error: unknown,
  source: string,
  taskMode: boolean,
): string {
  const code = errorCode(error);
  if (code === "ENOENT" && taskMode) {
    return `Task artifact is absent at ${source}. The .fusion directory is gitignored and typically missing in a fresh worktree; use --file or stdin instead.`;
  }
  if (code === "ENOENT") return `Input file does not exist: ${source}.`;
  if (code === "EACCES") return `Input file is not readable: ${source}.`;
  return `Could not read input from ${source}.`;
}

export async function runValidationCauseCli(
  argv: readonly string[],
  io: ValidationCauseCliIo,
): Promise<number> {
  const args = parseCliArguments(argv);
  if (args.mode === "usage-error") return writeCliError(io, args.message);

  let description: string;
  if (args.mode === "stdin") {
    try {
      description = await io.readStdin();
    } catch {
      return writeCliError(io, "Could not read validation cause from stdin.");
    }
  } else {
    const path =
      args.mode === "task"
        ? taskDescriptionPath(io.repositoryRoot, args.taskId)
        : args.path;
    let raw: string;
    try {
      raw = await io.readFile(path);
    } catch (error) {
      return writeCliError(
        io,
        readFailureMessage(error, path, args.mode === "task"),
      );
    }
    if (args.mode === "task") {
      const extracted = extractDescriptionFromTaskJson(raw);
      if (!extracted.ok) return writeCliError(io, extracted.message);
      description = extracted.description;
    } else {
      description = raw;
    }
  }

  const report = classifyValidationCause(description);
  io.writeOut(`${formatValidationCauseReport(report)}\n`);
  return exitCodeForValidationCause(report);
}
