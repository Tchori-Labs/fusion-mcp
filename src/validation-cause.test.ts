import { describe, expect, it } from "vitest";

import {
  classifyValidationCause,
  EXIT_CLASSIFIED,
  EXIT_CLEAR,
  EXIT_USAGE_OR_IO,
  EXPECTED_SYNTHESIZED_MESSAGE_COUNT,
  exitCodeForValidationCause,
  formatValidationCauseReport,
  parseValidationCauses,
  SYNTHESIZED_VALIDATOR_MESSAGES,
} from "./validation-cause.js";

const realOccurrences = [
  {
    task: "KB-035",
    runId: "VR-MS428ZM5-0003-FT5P",
    assertionId: "CA-MRKOU4AY-000P-7F1V",
    cause: `## Validation cause
Source feature: F-MRKOU4AX-000O-5E7H
Validator run: VR-MS428ZM5-0003-FT5P
Failed assertions: CA-MRKOU4AY-000P-7F1V
### CA-MRKOU4AY-000P-7F1V (fail)
Details: Validator omitted linked assertion result.`,
  },
  {
    task: "KB-036 inherited",
    runId: "VR-MS428ZM5-0003-FT5P",
    assertionId: "CA-MRKOU4AY-000P-7F1V",
    cause: `## Validation cause
Source feature: F-MRKOU4AX-000O-5E7H
Validator run: VR-MS428ZM5-0003-FT5P
Failed assertions: CA-MRKOU4AY-000P-7F1V
### CA-MRKOU4AY-000P-7F1V (fail)
Details: Validator omitted linked assertion result.`,
  },
  {
    task: "KB-036 appended",
    runId: "VR-MS430NW3-000L-JROW",
    assertionId: "CA-MS42E3HL-000B-DVBP",
    cause: `## Validation cause
Source feature: F-MS429QQE-0006-2K7T
Validator run: VR-MS430NW3-000L-JROW
Failed assertions: CA-MS42E3HL-000B-DVBP
### CA-MS42E3HL-000B-DVBP (fail)
Details: Validator omitted linked assertion result.`,
  },
  {
    task: "KB-037",
    runId: "VR-MS43MAAX-0016-V7D8",
    assertionId: "CA-MRKOU4B3-000R-DFTU",
    cause: `## Validation cause
Source feature: F-MRKOU4B2-000Q-KMY2
Validator run: VR-MS43MAAX-0016-V7D8
Failed assertions: CA-MRKOU4B3-000R-DFTU
### CA-MRKOU4B3-000R-DFTU (fail)
Details: Validator omitted linked assertion result.`,
  },
  {
    task: "KB-040 inherited",
    runId: "VR-MS43MAAX-0016-V7D8",
    assertionId: "CA-MRKOU4B3-000R-DFTU",
    cause: `## Validation cause
Source feature: F-MRKOU4B2-000Q-KMY2
Validator run: VR-MS43MAAX-0016-V7D8
Failed assertions: CA-MRKOU4B3-000R-DFTU
### CA-MRKOU4B3-000R-DFTU (fail)
Details: Validator omitted linked assertion result.`,
  },
  {
    task: "KB-040 appended",
    runId: "VR-MS45R27U-0049-H0XM",
    assertionId: "CA-MS43N6CS-001F-JHHW",
    cause: `## Validation cause
Source feature: F-MS43N57R-001A-XXZH
Validator run: VR-MS45R27U-0049-H0XM
Failed assertions: CA-MS43N6CS-001F-JHHW
### CA-MS43N6CS-001F-JHHW (fail)
Details: Validator omitted linked assertion result.`,
  },
] as const;

function cause(details: string, extra = "", verdict = "fail"): string {
  return `## Validation cause
Source feature: F-1
Validator run: VR-1
Failed assertions: CA-1
### CA-1 (${verdict})
Details: ${details}${extra}`;
}

describe("validation-cause parser and classifier", () => {
  it.each(realOccurrences)(
    "classifies verbatim real occurrence $task as non-substantive",
    ({ cause: input, runId, assertionId }) => {
      const report = classifyValidationCause(input);
      expect(report.classification).toBe("non-substantive");
      expect(report.runIds).toEqual([runId]);
      expect(report.synthesizedAssertionIds).toEqual([assertionId]);
      expect(report.causes[0]?.assertions[0]?.synthesized).toBe(true);
    },
  );

  it("recognizes both synthesized placeholder messages", () => {
    const report = classifyValidationCause(
      cause("Duplicate validator result for linked assertion."),
    );
    expect(report.classification).toBe("non-substantive");
  });

  it("normalizes period, case, whitespace, trimming, and CRLF", () => {
    const input = cause("  VALIDATOR   OMITTED linked ASSERTION result  ")
      .replace("Details: ", "Details:\t")
      .replaceAll("\n", "\r\n");
    expect(classifyValidationCause(input).classification).toBe(
      "non-substantive",
    );
  });

  it("classifies blocked placeholders like failed placeholders", () => {
    const input = `## Validation cause
Source feature: F-1
Validator run: VR-1
Failed assertions: none recorded
Blocked assertions: CA-1
### CA-1 (blocked)
Details: Validator omitted linked assertion result.`;
    const parsed = parseValidationCauses(input)[0];
    expect(parsed?.failedAssertionIds).toEqual([]);
    expect(parsed?.blockedAssertionIds).toEqual(["CA-1"]);
    expect(parsed?.assertions[0]?.verdict).toBe("blocked");
    expect(classifyValidationCause(input).classification).toBe(
      "non-substantive",
    );
  });

  it("aggregates two synthesized blocks as non-substantive", () => {
    const input = `${cause("Validator omitted linked assertion result.")}\n${cause(
      "Duplicate validator result for linked assertion.",
    ).replaceAll("CA-1", "CA-2")}`;
    const report = classifyValidationCause(input);
    expect(report.causes).toHaveLength(2);
    expect(report.classification).toBe("non-substantive");
  });

  it("classifies a genuine finding as substantive", () => {
    const report = classifyValidationCause(
      cause(
        "Observed behaviour violates the requirement.",
        "\nExpected: safe\nObserved: unsafe",
      ),
    );
    expect(report.classification).toBe("substantive");
    expect(report.substantiveAssertionIds).toEqual(["CA-1"]);
  });

  it("classifies a mixed cause as mixed, never non-substantive", () => {
    const input = `## Validation cause
Source feature: F-1
Validator run: VR-1
Failed assertions: CA-1, CA-2
### CA-1 (fail)
Details: Validator omitted linked assertion result.
### CA-2 (fail)
Expected: safe
Observed: unsafe
Details: Real mismatch.`;
    const report = classifyValidationCause(input);
    expect(report.classification).toBe("mixed");
    expect(report.synthesizedAssertionIds).toEqual(["CA-1"]);
    expect(report.substantiveAssertionIds).toEqual(["CA-2"]);
  });

  it.each(["Expected: value", "Observed: value", "Evidence: recorded"])(
    "treats placeholder plus real field %s as substantive",
    (field) => {
      expect(
        classifyValidationCause(
          cause("Validator omitted linked assertion result.", `\n${field}`),
        ).classification,
      ).toBe("substantive");
    },
  );

  it("treats Additional evidence omitted: 2 as substantive", () => {
    expect(
      classifyValidationCause(
        cause(
          "Validator omitted linked assertion result.",
          "\nAdditional evidence omitted: 2",
        ),
      ).classification,
    ).toBe("substantive");
  });

  it("keeps Additional evidence omitted: 0 synthesized", () => {
    const assertion = parseValidationCauses(
      cause(
        "Validator omitted linked assertion result.",
        "\nAdditional evidence omitted: 0",
      ),
    )[0]?.assertions[0];
    expect(assertion?.omittedEvidenceCount).toBe(0);
    expect(assertion?.synthesized).toBe(true);
  });

  it("treats non-numeric omitted evidence conservatively as substantive", () => {
    const assertion = parseValidationCauses(
      cause(
        "Validator omitted linked assertion result.",
        "\nAdditional evidence omitted: unknown",
      ),
    )[0]?.assertions[0];
    expect(assertion?.omittedEvidenceInvalid).toBe(true);
    expect(assertion?.synthesized).toBe(false);
  });

  it("treats missing Details as substantive", () => {
    const input = `## Validation cause
Source feature: F-1
Validator run: VR-1
Failed assertions: CA-1
### CA-1 (fail)`;
    expect(classifyValidationCause(input).classification).toBe("substantive");
  });

  it("handles empty input, whitespace, and descriptions without cause blocks", () => {
    for (const input of ["", " \n\t", "ordinary task description"]) {
      expect(classifyValidationCause(input).classification).toBe("none");
    }
  });

  it("treats a block with an empty assertion section as substantive", () => {
    const report = classifyValidationCause(`## Validation cause
Source feature: F-1
Validator run: VR-1
Failed assertions: none recorded`);
    expect(report.causes[0]?.assertions).toEqual([]);
    expect(report.classification).toBe("substantive");
  });

  it("ignores sibling no assertion identity prose and trailing unknown lines", () => {
    const prose =
      "Validation failed for feature F-1: 1 assertion failed (no assertion identity).";
    expect(classifyValidationCause(prose).classification).toBe("none");
    const input = `${cause("Validator omitted linked assertion result.")}\n**Acceptance Criteria:**\nno assertion identity`;
    const report = classifyValidationCause(input);
    expect(report.synthesizedAssertionIds).toEqual(["CA-1"]);
    expect(JSON.stringify(report)).not.toContain('"no assertion identity"');
  });

  it("formats a compact human-readable report", () => {
    expect(
      formatValidationCauseReport(
        classifyValidationCause(
          cause("Validator omitted linked assertion result."),
        ),
      ),
    ).toBe(
      "Classification: non-substantive\nValidator runs: VR-1\nSynthesized assertions: CA-1\nSubstantive assertions: none",
    );
  });
});

describe("validation-cause invariants and exits", () => {
  it("keeps the synthesized placeholder list complete", () => {
    expect(SYNTHESIZED_VALIDATOR_MESSAGES.length).toBe(
      EXPECTED_SYNTHESIZED_MESSAGE_COUNT,
    );
  });

  it("keeps all three exit codes distinct", () => {
    expect(new Set([EXIT_CLEAR, EXIT_USAGE_OR_IO, EXIT_CLASSIFIED]).size).toBe(
      3,
    );
  });

  it.each([
    ["none", "", EXIT_CLEAR],
    ["substantive", cause("Real finding."), EXIT_CLEAR],
    [
      "non-substantive",
      cause("Validator omitted linked assertion result."),
      EXIT_CLASSIFIED,
    ],
    [
      "mixed",
      `${cause("Validator omitted linked assertion result.")}\n### CA-2 (fail)\nDetails: Real finding.`,
      EXIT_CLASSIFIED,
    ],
  ])("maps %s classification to its pinned exit", (_name, input, expected) => {
    expect(exitCodeForValidationCause(classifyValidationCause(input))).toBe(
      expected,
    );
  });
});
