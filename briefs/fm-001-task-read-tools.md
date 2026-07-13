# FM-001 — Task read tools

## Context

`fusion-mcp` is a governed MCP server wrapping the Fusion agent-board REST API.
FM-000 shipped the scaffold: `config.ts`, `fusion-client.ts` (the fetch-wrapper
client), `index.ts` (server building, audit logging, stdio + minimal HTTP), and
a working `get_board_health` tool. This task builds on that — depend on FM-000
being merged first. Read `SPEC.md` and `AGENTS.md` before starting — the
governance invariants and the cross-repo/no-merge protocol are binding.

## Scope

Implement the **read** tools on top of the existing `FusionClient`. Register each
in `buildServer` via `server.registerTool`, with zod raw-shape `inputSchema`
matching the scaffold's style. All accept an optional `projectId`; when omitted,
apply `config.defaultProjectId` (pass it through as the `projectId` **query
param**). Audit every call via `auditLog`.

Tools and backing endpoints:

- `list_projects` → `GET /api/projects` (no params)
- `list_tasks` → `GET /api/tasks` — params: `projectId?`, `limit?`, `offset?`,
  `q?`, `column?`, `includeArchived?`. Always send `limit`/`offset` (default them,
  e.g. `limit=50`, `offset=0`) — responses are otherwise unbounded.
- `get_task` → `GET /api/tasks/:id` — `id` (required), `projectId?`
- `get_task_logs` → `GET /api/tasks/:id/logs` — `id`, `limit?`, `offset?`. When
  `limit` is sent, Fusion returns `X-Total-Count` and `X-Has-More` headers;
  surface these in the tool result (e.g. a `pagination: { total, hasMore, offset,
  limit }` block alongside the logs) by reading `response.headers`.
- `get_task_workflow_results` → `GET /api/tasks/:id/workflow-results` — `id`
- `list_tasks` and the others: keep handlers thin.

## Files to touch

- `src/index.ts` — register the new tools in `buildServer`.
- `src/fusion-client.ts` — add small typed helpers only if they keep `buildServer`
  thin; reuse `request()`. Do not fatten the client into an SDK.
- Add `src/task-read-tools.test.ts` (or colocated per-tool tests).

## Tests required (no network — inject `fetch` / `FetchLike`)

- Each tool calls the correct method + path.
- `projectId` scoping: explicit `projectId` wins; omitted falls back to
  `FUSION_DEFAULT_PROJECT_ID`; neither ⇒ no `projectId` param sent.
- `list_tasks` / `get_task_logs`: `limit`/`offset` always present; query building
  drops `undefined`.
- `get_task_logs` pagination: mock `X-Total-Count`/`X-Has-More` and assert they
  appear in the result; also the no-`limit` (no headers) case.
- Error path: a 404 surfaces as a `FusionError` (token-free).

## Out of scope

Write tools (FM-002), settings/HTTP (FM-003), deploy/hardening (FM-004).

## Deliverable

PR against `Tchori-Labs/fusion-mcp` main, all five commands green
(`pnpm lint typecheck test build`). **Do not merge.**
