# Post-0.2 acceptance audit: Make our MCP usable

- **Goal:** `G-MRKOVBCD-0001-FTCK`
- **Audit date (UTC):** 2026-07-23
- **Audited task commit:** `c0cc1151df4d2a2937cf847c33c797d483cbeea6`
- **Compared develop commit:** `be8b84e`
- **Tree equivalence:** `git diff --name-status HEAD..origin/develop` was empty
  before audit edits. The task import commit is not a graph descendant of
  `origin/develop`, so tree equivalence is the recorded base-branch proof.

## Delta from the prior audit

The 2026-07-19 audit in `docs/acceptance-audit-goal-usable-mcp.md` covered 17
tools. The KB-025–KB-030 wave added packed-artifact and live multi-project
release gates, deep settings redaction, three governed writes
(`update_project_settings`, `update_task`, and `archive_task`), a 20-tool
contract baseline, branch reconciliation, and aligned governance prose. This
audit verifies that final 0.2 surface rather than reusing the earlier result.
Baseline inspection used `git rev-parse HEAD`, `date -u`, `git merge-base`,
`git diff --name-status HEAD..origin/develop`, `node --version`, `cat .nvmrc`,
and focused source `grep` searches. Contract evidence additionally ran
`pnpm exec vitest run` for `src/tool-error.test.ts`,
`src/tool-error.integration.test.ts`, `src/fusion-client.test.ts`,
`src/redact-settings.test.ts`, all three new-write suites,
`src/list-tasks-tool.test.ts`, and `src/get-task-logs-tool.test.ts`.

| Area                                                          | Disposition |
| ------------------------------------------------------------- | ----------- |
| 1. Governed surface and structural exclusions                 | **PASS**    |
| 2. Schemas, errors, audit, redaction, scope, and limits       | **PASS**    |
| 3. Command gates and network hermeticity                      | **PASS**    |
| 4. Package, transport, release, and live-gate reproducibility | **PASS**    |

## 1. Governed surface and structural exclusions — PASS

- `SPEC.md:124-143` and registrations at `src/index.ts:389-1106` agree on the
  exact 20 names: `get_board_health`, `list_tasks`, `get_task`, `get_task_logs`,
  `get_task_workflow_results`, `list_projects`, `read_project_settings`,
  `create_task`, `comment_task`, `steer_task`, `pause_task`, `unpause_task`,
  `list_approvals`, `get_approval`, `list_missions`, `get_mission`, `move_task`,
  `update_project_settings`, `update_task`, and `archive_task`. Pause/unpause
  share one registration loop; the only direct `server.registerTool` call is
  inside `registerGovernedTool`.
- The write set is exactly create, comment, steer, pause, unpause, move, settings
  update, task update, and archive. Endpoint inspection found no merge,
  approval-decision, publication, delete, bulk mutation, or daemon-control tool.
  Keyword matches outside this set were HTTP session deletion and graceful
  listener shutdown, not board endpoints.
- `src/pause-unpause-tools.test.ts:229-248` applies the prohibited-name regex and
  permits only exact `archive_task`. The strict settings object at
  `src/index.ts:79-93` and `SPEC_TOOL_INPUT_PROPERTIES` at
  `src/tool-contract.ts:10-59` make global settings, provider/model config, and
  credential keys inexpressible.
- Exact-order anchors agree in `src/health-tool.test.ts:56-83`,
  `src/project-tools.test.ts:74-102`, `src/http-transport.test.ts:455-490`, and
  the two transport live arrays. `tool-contract.json` has append-only major-0
  baselines growing to 20 tools with no historical removal.
- `pnpm contract:check` passed 29/29.

## 2. Documented contracts and 0.2 writes — PASS

- Zod shapes at `src/index.ts:31-148` match every catalogue property.
  `list_tasks` and `get_task_logs` default to limit 50/offset 0, accept integer
  limits 1–200, and reject negative offsets. `steer_task` accepts 1–2000
  characters; `create_task` constructs only its documented safe subset.
- `update_project_settings` accepts eight hard-allowlisted keys plus only
  `planApprovalMode: "require-all"`, rejects unknown/empty/unscoped input before
  fetch, sends project scope in the PUT query, logs sorted key names rather than
  values, and applies `redactSettings` to the response
  (`src/index.ts:941-1027`; `src/update-settings-tool.test.ts`).
- `update_task` PATCHes only dependencies, priority, title, and description;
  `archive_task` POSTs the encoded `/api/tasks/:id/archive` path
  (`src/index.ts:1029-1106`; `src/update-task-tool.test.ts` and
  `src/archive-task-tool.test.ts`). These satisfy SPEC invariants 2, 3, and 5.
- `src/tool-error.ts:8-168` defines the six stable codes, fixed public messages,
  safe status handling, redacted validation paths, and a generic internal
  failure. Every handler uses `withToolErrorEnvelope`; request interception at
  `src/index.ts:321-374` also normalizes and audits pre-dispatch validation.
- Every tool has a secret-free stderr audit site. `FusionClient` keeps bearer and
  edge credentials in headers and exposes token-free typed failures. Deep
  masking in `src/redact-settings.ts` covers reads and update responses,
  including nested object/array keys matching the documented credential pattern.
- Explicit `projectId` takes precedence over the configured default. Reads and
  the three new writes use documented query scope; creation, communication,
  pause/unpause, and movement use body scope. Logs expose parsed
  `X-Total-Count` and `X-Has-More` metadata.
- A focused run of the error, client, redaction, new-write, list, and log suites
  passed 110/110 across nine files.

## 3. Command gates and hermeticity — PASS

| Command                          | Outcome                                 |
| -------------------------------- | --------------------------------------- |
| `pnpm install --frozen-lockfile` | exit 0 on Node v22.23.1; `.nvmrc` is 22 |
| `pnpm lint`                      | exit 0                                  |
| `pnpm typecheck`                 | exit 0                                  |
| `pnpm test`                      | exit 0; 31 files, 358 tests             |
| `pnpm contract:check`            | exit 0; 29 tests                        |
| `pnpm build`                     | exit 0                                  |

`vitest.config.ts:3-11` always loads `src/test-setup/network-guard.ts` and excludes
live files. The guard blocks TCP, TLS, UDP, and DNS without a bypass;
`src/test-setup/network-guard.test.ts` passed 8/8. The only guard-free config is
`vitest.live.config.ts`, which includes only live files and is outside the
mandatory test command. `.github/workflows/ci.yml:7-57` runs the named **Build &
Test** check for pushes and pull requests on both integration and release
branches; it includes the mandatory gates plus format, unused-code, and package
checks.

## 4. Package, transport, release, and live gates — PASS

### Packed stdio and local HTTP

- After `pnpm build`, `pnpm pkgcheck` passed: the package linter reported
  `All good!` and `scripts/pack-smoke.sh` reported `pack-smoke: OK`. The script
  packs, scratch-installs, starts the installed bin with `--stdio`, and requires
  an MCP initialize response without a token or upstream call.
- A loopback HTTP smoke started `node dist/index.js --http` on an ephemeral port
  with `FUSION_BASE_URL=http://127.0.0.1:9`. Initialize issued a session id;
  `tools/list` returned all 20 names; DELETE cleared the session and logged its
  close; stdout stayed empty; SIGTERM exited with code 0 and no signal. Transcript
  summary: `session-issued=yes tools=20 delete-close=yes sigterm=clean`.
- README setup and session behavior matched both reproductions.

### Release and live wiring

- `.github/workflows/publish.yml:26-129` calls pack-smoke at the resolved
  fully-qualified release tag, calls live integration, and makes publication
  depend on both. Tag validation, exact tag checkout, release-branch ancestry,
  package-version equality, five release gates, and least-privilege OIDC posture
  remain intact. `src/publish-policy.test.ts` and
  `src/workflow-policy.test.ts` enforce these properties.
- `.github/workflows/pack-smoke.yml` exposes reusable and path-filtered pull
  request triggers, is credential-free, uses a tarball glob, and cannot assume
  the required check's name.
- `.github/workflows/live-integration.yml` matches `docs/live-integration.md`:
  manual/reusable/release-PR triggers, read-only permission, protected
  environment, PR-only missing-credential annotation, fail-closed reusable and
  manual runs, build-before-live ordering, and redacted traces.
- `.github/workflows/stability.yml` matches `docs/stability.md`: manual and daily,
  non-required, credential-free, hermetic repetitions, failure-only artifacts.
  `src/stability-runner.test.ts` passed. The stdio/HTTP expected-tool arrays are
  the same 20-name catalogue; the multi-project live journey covers explicit and
  default scope plus optional edge headers.
- `package.json` and `src/index.ts:385` both advertise 0.2.0; the 0.2.0 changelog
  now records both release gates. `src/release-hygiene.test.ts` passed.
- Credentialed `pnpm test:live` and `pnpm test:stability` were deliberately not
  run. Their CI wiring, policy tests, and runbooks are the reproducibility proof.

## Automated evidence index

Executed or included by the green mandatory gate:
`src/approvals-tools.test.ts`, `src/archive-task-tool.test.ts`,
`src/comment-steer-tools.test.ts`, `src/config.test.ts`,
`src/create-task-tool.test.ts`, `src/docs-governance.test.ts`,
`src/fusion-client.test.ts`, `src/get-task-logs-tool.test.ts`,
`src/get-task-tool.test.ts`, `src/get-task-workflow-results-tool.test.ts`,
`src/health-tool.test.ts`, `src/http-transport.test.ts`, `src/index.test.ts`,
`src/list-tasks-tool.test.ts`, `src/live/live-harness.test.ts`,
`src/missions-tools.test.ts`, `src/move-task-tool.test.ts`,
`src/pause-unpause-tools.test.ts`, `src/project-tools.test.ts`,
`src/prose-hygiene.test.ts`, `src/publish-policy.test.ts`,
`src/redact-settings.test.ts`, `src/release-hygiene.test.ts`,
`src/stability-runner.test.ts`, `src/test-setup/network-guard.test.ts`,
`src/tool-contract.test.ts`, `src/tool-error.integration.test.ts`,
`src/tool-error.test.ts`, `src/update-settings-tool.test.ts`,
`src/update-task-tool.test.ts`, and `src/workflow-policy.test.ts`.

Inspected but not credential-executed: `src/live/mcp-stdio.live.test.ts`,
`src/live/mcp-http.live.test.ts`, and `src/live/mcp-multi-project.live.test.ts`.

## Findings

| Severity | Finding                                                                                                       | Disposition                                   |
| -------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Low      | SPEC and README overgeneralized project scope as GET query / POST body, omitting the 0.2 query-scoped writes. | **Fixed here** in `SPEC.md` and `README.md`.  |
| Low      | The release runbook named a redundant provenance flag not used by the trusted-publisher workflow.             | **Fixed here** in `docs/release.md`.          |
| Low      | The 0.2.0 changelog omitted the required multi-project live release gate.                                     | **Fixed here** in `CHANGELOG.md`.             |
| —        | No runtime, governance, security, or larger gap was found.                                                    | **Accepted**; no follow-up task was required. |

## Recommendation

**Recommend archiving goal `G-MRKOVBCD-0001-FTCK`.** All four areas pass, the
20-tool contract and structural exclusions hold, mandatory and package gates are
green, both local transport smokes succeed, and all findings were small prose
drift fixed in this audit. This is a recommendation only; the archive decision
remains with a human.
