# FM-000 — Project scaffold and proof-of-life tool

## Context

This repository currently contains only the contract: `SPEC.md` (what to
build), `AGENTS.md` (how work happens here — binding rules), a CI workflow,
and these briefs. There is **no code yet**. You are building the project
scaffold from the spec.

Read `SPEC.md` fully first — the architecture (config → fetch client → MCP
tools), the tool table, and the **Governance invariants** are the contract.
Read `AGENTS.md` for the binding cross-repo/no-merge protocol.

## Scope

1. **Toolchain**: TypeScript (strict), Node 22 (`.nvmrc` already present),
   **pnpm** as package manager, `vitest` for tests, `eslint` (flat config),
   build with plain `tsc` (no bundler). Use the current
   `@modelcontextprotocol/sdk` and `zod`. Required scripts, all green:
   `pnpm lint`, `pnpm typecheck`, `pnpm test` (vitest run), `pnpm build`.
2. **`src/config.ts`** — parse and validate env: `FUSION_BASE_URL` (default
   `http://127.0.0.1:4040`), `FUSION_TOKEN` (optional at parse time; a
   `requireToken()` helper throws a clear, token-free error), `PORT` (default
   4141), `FUSION_DEFAULT_PROJECT_ID` (optional).
3. **`src/fusion-client.ts`** — a small fetch wrapper class around the Fusion
   REST API: bearer `Authorization` header, request timeout, normalized
   error type whose messages NEVER contain the token, injectable `fetch`
   (so tests never touch the network). Methods for now: `getHealth()`
   (`GET /api/health`, auth-exempt) and `getSystemInfo()`
   (`GET /api/system/info`). Keep it a thin wrapper, not an SDK.
4. **`src/index.ts`** — CLI entry: builds an `McpServer`, registers ONE
   proof-of-life tool `get_board_health` (health + best-effort system info
   when a token is configured), supports stdio transport (default) and a
   minimal Streamable HTTP mode behind `--http` bound to loopback. Include an
   `auditLog(tool, argsSummary)` helper writing one timestamped, secret-free
   line to **stderr** per tool call (stdout belongs to the stdio protocol).
5. **Tests** (colocated `*.test.ts`): config parsing/defaults/requireToken,
   client auth header + error normalization + timeout, and the
   `get_board_health` tool happy path — all with injected/mocked fetch, no
   network.
6. **CI**: `.github/workflows/ci.yml` contains a "Pre-FM-000 guard" step and
   `if:` conditions. Remove the guard so every step runs unconditionally. Do
   NOT rename the job — its name `Build & Test` is the required
   branch-protection check.
7. Update `README.md`'s status line to reflect that the scaffold exists.

## Out of scope

All other tools (task read: FM-001, task write: FM-002, settings + full HTTP
transport: FM-003, deployment docs: FM-004). Do not implement them, even
partially, beyond what `get_board_health` needs.

## Deliverable

A pull request against `Tchori-Labs/fusion-mcp` `main`, with
`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all green and the CI
guard removed. **Do not merge** — a human reviews and merges.
