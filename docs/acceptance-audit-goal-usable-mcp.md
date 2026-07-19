# Acceptance audit: Make our MCP usable

- **Goal:** `G-MRKOVBCD-0001-FTCK`
- **Audit date (UTC):** 2026-07-19
- **Audited worktree commit:** `4bec64285762146ce3ce2f62d910b732cbd89d98`
- **Compared develop commit:** `9b1b821fec56e3f62348af238206740ce0bc5531`
- **Tree equivalence:** `git diff --quiet 4bec64285762146ce3ce2f62d910b732cbd89d98 develop` exited 0 before audit edits.

## Summary

| Area | Disposition |
| --- | --- |
| Governed tool surface and structural exclusions | **PASS** |
| Schemas, errors, audit, redaction, scoping, and limits | **PASS** |
| Mandatory gates and network hermeticity | **PASS** |
| README setup, stdio smoke, and HTTP smoke | **PASS** |

Two low-severity documentation discrepancies were corrected during the audit in
`9c4440683fea75d9e3c37a636947cc3a87d48f5e`. No runtime defect or larger
follow-up was found.

Inspection commands, in addition to the gate table below, were:
`git status --short --branch`, `git rev-parse HEAD`, `node --version`,
`cat .nvmrc`, source `grep` searches for tool registrations, API paths, audit
calls, and forbidden mutation terms, plus
`pnpm exec vitest run src/tool-error.test.ts src/tool-error.integration.test.ts
src/fusion-client.test.ts src/list-tasks-tool.test.ts
src/get-task-logs-tool.test.ts src/create-task-tool.test.ts
src/project-tools.test.ts src/approvals-tools.test.ts
src/missions-tools.test.ts src/move-task-tool.test.ts` (114/114 passed).

## 1. Governed tool surface — PASS

- The catalogue in `SPEC.md:95-136` and the exact `tools/list` assertion in
  `src/health-tool.test.ts:54-84` contain the same 17 names. The source
  registrations are at `src/index.ts:331-827`. There is no name present in only
  one set.
- The six writes are exactly `create_task`, `comment_task`, `steer_task`,
  `pause_task`, `unpause_task`, and `move_task`. Source endpoint inspection found
  no merge, approval-decision, publishing, settings-write, destructive task, or
  daemon-control route. Approval and mission routes are GET-only; settings uses
  `GET /api/settings`.
- `pnpm contract:check` passed 29/29 tests against the generated,
  append-only `tool-contract.json` history. `src/tool-contract.test.ts` also
  rejects names and top-level properties outside the specification catalogue.
- A production-source search for forbidden terms found only HTTP transport
  session-map deletion and graceful listener shutdown. Those are transport
  lifecycle operations, not exposed tools or board/system API mutations.

**Trade-off:** structural evidence combines exact-list and compatibility tests
with source endpoint inspection. Transport teardown necessarily uses DELETE and
shutdown concepts, so raw keyword matches were classified by call site rather
than treated as tool-surface violations.

## 2. Documented contracts — PASS

- Input shapes at `src/index.ts:32-112` match every catalogue parameter.
  `list_tasks` and `get_task_logs` default to `limit=50`, `offset=0`, reject
  non-integers and negative offsets, and cap limits at 200. `steer_task` enforces
  1–2000 characters. `create_task` constructs only the documented safe body.
- `src/tool-error.ts:8-168` defines all six stable codes, fixed safe messages,
  status rules, schema-derived validation paths, and generic internal failures.
  `withToolErrorEnvelope` wraps every registered handler; the interception at
  `src/index.ts:268-299` normalizes and audits validation failures before strict
  protocol parsing.
- Registration and audit-call-site enumeration matched one-for-one: 16 source
  registration sites represent all 17 tools because pause/unpause share a loop.
  Summaries omit tokens and full communication bodies. `FusionClient` attaches
  authorization only as a request header and normalizes failures to
  method/path/status metadata (`src/fusion-client.ts:49-186`).
- Explicit `projectId` takes precedence over the configured default. Scoped GETs
  use query parameters; `create_task` and `move_task` put scope in POST bodies.
  Instance-scoped health/project listing sends no project scope. Log pagination
  consumes `X-Total-Count` and `X-Has-More`.
- A targeted contract run covering errors, client behavior, limits, scoping,
  approvals, missions, and movement passed 114/114 tests.

**Automated evidence:** `src/tool-error.test.ts`,
`src/tool-error.integration.test.ts`, `src/fusion-client.test.ts`,
`src/list-tasks-tool.test.ts`, `src/get-task-logs-tool.test.ts`,
`src/create-task-tool.test.ts`, `src/get-task-tool.test.ts`,
`src/get-task-workflow-results-tool.test.ts`, `src/project-tools.test.ts`,
`src/comment-steer-tools.test.ts`, `src/pause-unpause-tools.test.ts`,
`src/approvals-tools.test.ts`, `src/missions-tools.test.ts`, and
`src/move-task-tool.test.ts`.

**Trade-off:** project identifiers are treated as non-sensitive identifiers by
`SPEC.md:208-219`; free-text bodies and tokens remain excluded. README wording
that overclaimed project-identifier omission was corrected to match the tested
behavior.

## 3. Mandatory gates and hermeticity — PASS

| Command | Outcome |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0 on Node v22.23.1; `.nvmrc` is 22 |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | exit 0; 22 files, 241 tests |
| `pnpm build` | exit 0 |
| `pnpm contract:check` | exit 0; 29 tests |

The mandatory test was run once on the audited tree and again after documentation
fixes; both runs passed 241/241. `vitest.config.ts:3-11` unconditionally loads
`src/test-setup/network-guard.ts` and excludes live tests. The guard has no
allowlist or environment escape and blocks TCP, TLS, UDP, HTTP(S), and DNS.
`src/test-setup/network-guard.test.ts` passed 8/8. The only guard-free config is
`vitest.live.config.ts`, which includes only `*.live.test.ts` and is not called by
`pnpm test`. `.github/workflows/ci.yml:7-51` runs the same five mandatory commands
on `develop` and `main` under **Build & Test**.

**Test files in the full gate:** `src/approvals-tools.test.ts`,
`src/comment-steer-tools.test.ts`, `src/config.test.ts`,
`src/create-task-tool.test.ts`, `src/fusion-client.test.ts`,
`src/get-task-logs-tool.test.ts`, `src/get-task-tool.test.ts`,
`src/get-task-workflow-results-tool.test.ts`, `src/health-tool.test.ts`,
`src/http-transport.test.ts`, `src/index.test.ts`,
`src/list-tasks-tool.test.ts`, `src/missions-tools.test.ts`,
`src/move-task-tool.test.ts`, `src/pause-unpause-tools.test.ts`,
`src/project-tools.test.ts`, `src/prose-hygiene.test.ts`,
`src/release-hygiene.test.ts`, `src/test-setup/network-guard.test.ts`,
`src/tool-contract.test.ts`, `src/tool-error.integration.test.ts`, and
`src/tool-error.test.ts`.

**Trade-off:** the credentialed live suite is intentionally outside the mandatory
gate. Its patterns were inspected in `src/live/mcp-stdio.live.test.ts`,
`src/live/mcp-http.live.test.ts`, and `src/live/live-harness.ts`; this audit used
credential-free loopback smoke processes instead.

## 4. README and transport smoke paths — PASS

After `pnpm build`, the README commands were reproduced without a token or an
upstream board request:

1. **stdio:** spawned `node dist/index.js --stdio`; client connection completed
   MCP initialize, and `tools/list` returned the exact governed 17-tool list.
2. **HTTP:** spawned `PORT=<ephemeral> node dist/index.js --http` on loopback;
   initialize issued a non-empty `mcp-session-id`; session `tools/list` returned
   the same list; DELETE cleared the session; init/close diagnostics appeared on
   stderr; stdout stayed empty; SIGTERM produced exit code 0 with no signal.

The configuration table, build command, executable paths, session behavior, and
loopback endpoint in `README.md:22-95` were reproducible. No throwaway smoke file
was checked in.

**Trade-off:** smoke coverage proves setup, initialization, catalogue discovery,
session deletion, and graceful process shutdown. It deliberately avoids calling
an upstream endpoint; authenticated read journeys remain in the opt-in live
suite.

## Findings

| Severity | Finding | Disposition |
| --- | --- | --- |
| Low | `SPEC.md` described the exact health-tool regression as an obsolete two-tool list. | **Fixed here**: now describes the implemented 17-tool assertion. |
| Low | README claimed project identifiers never appear in audits, while the settings-read audit intentionally records its non-sensitive resolved identifier. | **Fixed here**: wording now matches the specification and tests. |
| — | No runtime, governance, security, or larger unrelated gap was found. | **Accepted**; no follow-up task required. |

## Recommendation

**Archive goal `G-MRKOVBCD-0001-FTCK`.** All four acceptance areas pass, the
mandatory gates and both smoke paths are reproducible, and the only findings were
small documentation discrepancies fixed in this audit.
