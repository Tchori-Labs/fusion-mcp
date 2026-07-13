# FM-002 — Task write tools

## Context

`fusion-mcp` is a governed MCP server wrapping the Fusion agent-board REST API.
The scaffold ships `FusionClient` (with a `request()` primitive), `buildServer`,
and `auditLog`. Read `SPEC.md` and `AGENTS.md` first. The **governance
invariants** are binding: the only writes allowed are task creation and
communication. Do **not** add merge/approve/settings/delete/restart tools.

## Scope

Implement the **write** tools on top of `FusionClient.request`. For POST calls,
`projectId` is a **body field** (not a query param); when a tool omits it, apply
`config.defaultProjectId`. Audit every call via `auditLog` (summary of ids /
titles / columns only — never full free-text bodies or tokens).

Tools and backing endpoints:

- `create_task` → `POST /api/tasks`. Expose ONLY this safe subset:
  `description` (required), `title?`, `column?`, `priority?`,
  `dependencies?: string[]`, `workflowId?`, `baseBranch?`, `projectId?`. Do not
  surface any other field the API may accept.
- `comment_task` → `POST /api/tasks/:id/comments`, body `{ text, author? }`.
  Params: `id` (required), `text` (required), `author?`.
- `steer_task` → `POST /api/tasks/:id/steer`, body `{ text }`. Params: `id`,
  `text`. **Enforce 1–2000 chars client-side** (zod `.min(1).max(2000)`); a
  validation failure must never reach the network.
- `pause_task` → `POST /api/tasks/:id/pause` (no body). Param: `id`.
- `unpause_task` → `POST /api/tasks/:id/unpause` (no body). Param: `id`.

## Files to touch

- `src/index.ts` — register the write tools in `buildServer`.
- `src/fusion-client.ts` — reuse `request()`; add tiny helpers only if they keep
  handlers thin.
- Add `src/task-write-tools.test.ts` (or colocated per-tool tests).

## Input validation

Use zod raw-shape `inputSchema` in `registerTool` (match the scaffold). Enforce:
`description` non-empty, `steer_task.text` 1–2000 chars, `dependencies` an array
of strings. Rely on the SDK to reject invalid input before your handler runs, and
also assert the bounds in tests.

## Tests required (no network — inject `fetch` / `FetchLike`)

- `create_task`: only whitelisted fields are sent; `projectId` in the **body**;
  default-project fallback; missing `description` rejected.
- `comment_task`: body `{ text, author? }`; `author` omitted when unset.
- `steer_task`: text at 1 and 2000 chars accepted; empty and 2001 chars rejected
  **without** a fetch call.
- `pause_task` / `unpause_task`: correct path, no body.
- Error path: non-2xx surfaces as token-free `FusionError`.

## Out of scope

Read tools (FM-001), settings/HTTP (FM-003), deploy/hardening (FM-004).

## Deliverable

PR against `Tchori-Labs/fusion-mcp` main, all five commands green. **Do not merge.**
