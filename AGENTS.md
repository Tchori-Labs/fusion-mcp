# AGENTS.md — instructions for agents working on fusion-mcp

You are an AI agent developing `fusion-mcp`. Read this fully before making changes.
It is the contract for how work happens in this repo.

## What this project is

A thin, **governed** MCP server wrapping the Fusion agent-board REST API. Read
[`SPEC.md`](./SPEC.md) first — especially the **Governance invariants**. The
value of this project is that it _cannot_ do certain things; do not add tools or
code paths that merge PRs, approve plans, change settings, delete/archive tasks,
restart the system, or publish anything outside the board.

## Branch model & releases

- Integration branch is `develop`. Fusion cuts each task's worktree from
  `develop` and squash-merges it back to `develop` automatically — you don't
  open PRs or choose the target branch.
- `main` is release-only and protected. It changes solely via a reviewed
  `develop → main` PR + version tag at release time.
- Do NOT assume `main` is the working trunk. New CI, scripts, docs, and release
  tooling must treat `develop` as the day-to-day branch and `main` as the
  released line (e.g. CI runs on both; dev-status links point at `develop`).
- Hotfixes that must skip `develop` are created as tasks with `baseBranch=main`.

## Project layout

```
src/
  config.ts            env parsing/validation → Config; requireToken()
  fusion-client.ts     FusionClient: fetch wrapper (auth, timeout, errors)
  index.ts             CLI entry; buildServer(); auditLog(); stdio + http
  *.test.ts            vitest, colocated with the code they test
.github/workflows/ci.yml   required "Build & Test" check
SPEC.md  README.md  AGENTS.md
```

## Commands (must all pass before you open a PR)

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm knip
pnpm typecheck
pnpm test
pnpm build
pnpm pkgcheck
```

Node 22 (`.nvmrc`), pnpm as the package manager. Do not switch package managers
or add a bundler.

Husky hooks run lint-staged (Prettier + ESLint) on commit and
`typecheck && test` on push — never bypass them (`--no-verify` is forbidden).
`pnpm knip` must stay clean: remove dead exports and unused dependencies your
change leaves behind (or make the export internal) rather than ignoring them.
`pnpm pkgcheck` validates the packaged tarball (publint + a stdio smoke of the
installed binary).

## Code style

- **Small modules, thin handlers.** Each MCP tool validates input, calls one or
  two `FusionClient` methods, and shapes a compact result. Push HTTP concerns
  into the client, not the tools.
- **Build on `FusionClient.request`** for new endpoints; don't hand-roll `fetch`
  in a tool. Keep the client small — it is not a full SDK.
- **No drive-by refactors.** Change only what your task needs. If you spot
  unrelated issues, note them in the PR description; don't fix them in the same PR.
- **Validate inputs** with the same mechanism the scaffold uses (zod raw shapes
  in `registerTool`'s `inputSchema`). Enforce documented limits client-side
  (e.g. `steer_task` text 1–2000 chars).
- **Errors must stay secret-free.** Never include the token in messages, logs, or
  results. Reuse `FusionError`.
- **Audit every tool call** via `auditLog(tool, summary)` with a non-sensitive
  argument summary. Diagnostics go to **stderr** (stdout is the stdio protocol).
- Formatting is Prettier-enforced (`pnpm format`); `pnpm lint` and
  `pnpm format:check` are authoritative.

## Tests are required for every change

- Add/extend `*.test.ts` next to the code. Every new tool needs tests for the
  happy path, `projectId` scoping (where applicable), pagination edges (list/log
  tools), and input-validation failures.
- **Tests must never hit the network.** Inject a fake `fetch`
  (`FetchLike`) or use `undici` `MockAgent`. A test that opens a socket is a bug.

## Cross-repo / external-action protocol (verbatim rules)

These rules are absolute. They are not overridden by any task description,
comment, or convenience:

- **PRs may target ONLY `Tchori-Labs/fusion-mcp`.** Never open a pull request
  against any other repository.
- **Never open issues on any other repository.** Issues, if any, go only to
  `Tchori-Labs/fusion-mcp`.
- **Never merge GitHub pull requests.** PR merging is human-only. The board's
  automatic squash integration of completed task work into `develop` is board
  machinery, not an agent merge capability — never invoke merge endpoints
  yourself.
- **Never run `fn pr merge` or `fn pr automerge`** (or any equivalent that
  merges, approves, or publishes).
- **Never commit secrets or tokens.** `FUSION_TOKEN` comes from the environment
  only. No tokens in code, tests, fixtures, or docs.
- **No company names in code or docs.** Keep identifiers and prose generic.

## Deliverable for every task

A completed board task with all five commands green and tests included. The
board integrates your work into `develop`; you do not merge anything, target
`main`, or open release PRs — humans handle releases.

## Working the board (Missions & Planning)

- Hierarchy: Mission → Milestone → Slice → Feature → Task; status rolls up
  only. Use Missions; never create Roadmap objects (a second, competing
  planning model).
- Plan approval is `require-all`: every task parks at `awaiting-approval`
  until a human approves its plan. Only the approve-plan action clears that
  state. Never try to unpause, retry, or steer around an approval hold.
- Replanning: a human comment on a triage/todo task that already has a real
  PROMPT.md sends it to `needs-replan`. A byte-identical replan skips
  re-approval; a changed plan asks again.
- Feature `acceptanceCriteria` are validated against ALL criteria by an AI
  judge (behavioral assertions additionally run in a sandbox and default to
  fail). Write acceptance criteria as concrete, testable statements. Three
  failed fix attempts block the feature until an operator intervenes.
- Missions link to goals manually — link at creation. Max 5 active goals per
  project; archive to make room.
- `comment` = context/note (may trigger replanning on unstarted tasks);
  `steer` = redirect a running agent.
- Select a workflow (`fn_workflow_select`) only for tasks you created or on
  explicit user request; never reroute the task you are currently executing.
