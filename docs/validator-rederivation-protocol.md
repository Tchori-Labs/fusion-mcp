# Validator re-derivation protocol

## Scope

This advisory detector is a human-authorized partial mitigation for KB-039. The
engine-side requirements to persist a concrete verdict for every linked
assertion and to report result-capture failures as infrastructure errors were
escalated rather than fixed. Nothing in this repository should be read as
evidence that the validator defect was resolved.

## Defect mechanism

When the board engine receives no model-supplied result for a linked assertion,
its normalizer substitutes a failing assertion with the fixed detail
`Validator omitted linked assertion result.`. When it receives duplicate results
for one linked assertion, it substitutes the sibling detail
`Duplicate validator result for linked assertion.`. These synthesized records
carry an assertion id, failing verdict, passed flag, and message, but no expected,
observed, evidence, or omitted-evidence fields.

The synthesized failure is rendered in the same `## Validation cause` format as
a substantive code finding. The board can therefore derive another feature even
though the recorded result contains no code-level evidence.

## Incident record

The canonical occurrence model is **4 unique validator runs across 6 cause
blocks in 4 spawned tasks**, re-deriving 2 already-delivered underlying features.
Two runs occur twice because a derived task inherited the prior cause block and
then appended a new one.

| Validator run           | Assertion               | Source feature         | Tasks containing the block |
| ----------------------- | ----------------------- | ---------------------- | -------------------------- |
| `VR-MS428ZM5-0003-FT5P` | `CA-MRKOU4AY-000P-7F1V` | `F-MRKOU4AX-000O-5E7H` | KB-035, KB-036             |
| `VR-MS430NW3-000L-JROW` | `CA-MS42E3HL-000B-DVBP` | `F-MS429QQE-0006-2K7T` | KB-036                     |
| `VR-MS43MAAX-0016-V7D8` | `CA-MRKOU4B3-000R-DFTU` | `F-MRKOU4B2-000Q-KMY2` | KB-037, KB-040             |
| `VR-MS45R27U-0049-H0XM` | `CA-MS43N6CS-001F-JHHW` | `F-MS43N57R-001A-XXZH` | KB-040                     |

The validator, result persistence, and feature derivation belong to the board
engine, outside this repository. The engine-side remedy must be escalated to a
human for routing. Agents working here must never pursue it through a
cross-repository PR or issue.

## Residual risk

This detector is advisory. It does not prevent board-side feature derivation, a
duplicate task from being filed, or blind implementation by an executor who
never runs the check. Such an executor is exactly as exposed as before.

The command cannot be a mandatory test, build, hook, or CI gate. Its task input
lives under `.fusion`, which is gitignored and normally absent from a fresh
worktree. A mandatory suite would therefore always skip or fail rather than
provide reliable enforcement.

## Classify before implementing

For every task carrying a validation cause, run `pnpm rederivation:check` before
implementing. A `non-substantive` or `mixed` result forbids blind
re-implementation. Investigate the delivered feature independently along three
axes:

1. **Production code:** verify the required runtime behaviour and wiring.
2. **Tests:** verify behaviour-focused regression coverage, not filenames or
   phrase matches.
3. **Documentation:** verify the promised operator and contract content, not
   filenames or phrase matches.

Judge each axis independently by behaviour and content. Remediation is confined
to the axis that is genuinely deficient; evidence on one axis never substitutes
for another. Record the evidence with `fn_task_document_write`. If every axis is
already satisfied, close the verification-only task with a leading `NO-OP:`
sentinel rather than fabricating a commit.

A `mixed` result contains both synthesized and substantive assertions. It
requires investigation of every substantive assertion and must never be reduced
to a non-finding. Likewise, expected, observed, or evidence fields make an
assertion substantive. `Additional evidence omitted: N` with a positive number
proves real evidence existed and was truncated; malformed counts are treated
conservatively as substantive.

## CLI input and exit contract

The command accepts exactly one of these input modes:

- `pnpm rederivation:check -- --file <path>` reads a description from a file.
- `pnpm rederivation:check -- --task <ID>` reads
  `.fusion/tasks/<ID>/task.json`, which must be a JSON object with a top-level
  string `description` field.
- `pnpm rederivation:check` reads the description from stdin.

The pinned exit codes are:

- **0 — clear:** no validation cause or only substantive assertions.
- **2 — classified:** at least one synthesized assertion, producing
  `non-substantive` or `mixed`.
- **1 — usage or I/O error:** arguments, reads, or task-artifact shape prevented
  classification.

Exit 2 and exit 1 are intentionally distinct so automation can distinguish a
classified finding from a failure to run the detector.
