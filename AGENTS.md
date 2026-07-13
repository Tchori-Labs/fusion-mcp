# AGENTS.md — instructions for agents working on fusion-mcp

You are an AI agent developing `fusion-mcp`. Read this fully before making changes.
It is the contract for how work happens in this repo.

## What this project is

A thin, **governed** MCP server wrapping the Fusion agent-board REST API. Read
[`SPEC.md`](./SPEC.md) first — especially the **Governance invariants**. The
value of this project is that it *cannot* do certain things; do not add tools or
code paths that merge PRs, approve plans, change settings, delete/archive tasks,
restart the system, or publish anything outside the board.

## Project layout

```
src/
  config.ts            env parsing/validation → Config; requireToken()
  fusion-client.ts     FusionClient: fetch wrapper (auth, timeout, errors)
  index.ts             CLI entry; buildServer(); auditLog(); stdio + http
  *.test.ts            vitest, colocated with the code they test
briefs/                task briefs (FM-00x) — what to build next
.github/workflows/ci.yml   required "Build & Test" check
SPEC.md  README.md  AGENTS.md
```

## Commands (must all pass before you open a PR)

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Node 22 (`.nvmrc`), pnpm as the package manager. Do not switch package managers
or add a bundler.

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
- Match the existing formatting; `pnpm lint` is authoritative.

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
- **Never merge PRs.** Merging is human-only. Auto-merge is off by design and
  must stay off.
- **Never run `fn pr merge` or `fn pr automerge`** (or any equivalent that
  merges, approves, or publishes).
- **Never commit secrets or tokens.** `FUSION_TOKEN` comes from the environment
  only. No tokens in code, tests, fixtures, or docs.
- **No company names in code or docs.** Keep identifiers and prose generic.

## Deliverable for every task

A pull request against `Tchori-Labs/fusion-mcp` `main`, with all five commands
green and tests included. **Do not merge it** — a human does that.
