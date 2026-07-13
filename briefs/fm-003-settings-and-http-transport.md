# FM-003 — Settings tool + Streamable HTTP transport

## Context

`fusion-mcp` is a governed MCP server wrapping the Fusion agent-board REST API.
The scaffold ships `FusionClient`, `buildServer`, `auditLog`, a full **stdio**
transport, and a **minimal stateless** HTTP mode in `src/index.ts` (fresh server
+ `StreamableHTTPServerTransport` per request, JSON responses, loopback). Read
`SPEC.md` and `AGENTS.md` first; governance invariants are binding — settings are
**read-only**.

## Scope

### 1. `read_project_settings` tool

- `read_project_settings` → `GET /api/settings`, param `projectId?` (query),
  default-project fallback. **Read-only** — no settings-write tool, ever. Thin
  handler, audited.

### 2. Finish the Streamable HTTP transport

Replace the minimal stateless handler with proper session handling per the
**current `@modelcontextprotocol/sdk` docs** (verify against the installed
version — do not assume):

- Maintain a map of `mcp-session-id` → transport. On an `initialize` request with
  no session, create a transport with a `sessionIdGenerator` (e.g. `randomUUID`),
  wire `onsessioninitialized` / `onsessionclosed` to add/remove from the map, and
  connect a server built by `buildServer`. Route subsequent requests with a known
  session id to the existing transport.
- Handle `GET` (SSE stream) and `DELETE` (session teardown) as the SDK expects.
- Keep the DNS-rebinding / host protections the SDK offers; bind to loopback.
- **Graceful shutdown:** on `SIGINT`/`SIGTERM`, stop accepting connections, close
  all transports and servers, then exit.
- **Audit-log integration:** ensure tool-call audit lines (`auditLog`) are emitted
  in HTTP mode exactly as in stdio (they already fire inside handlers — verify),
  and log session lifecycle (init/close) to stderr.

## Files to touch

- `src/index.ts` — settings tool registration + HTTP transport rewrite +
  shutdown handling. Consider extracting the HTTP server into `src/http.ts` if it
  keeps `index.ts` readable (small modules preferred).
- `src/fusion-client.ts` — reuse `request()` for settings.
- Tests: `src/settings-tool.test.ts` and `src/http-transport.test.ts`.

## Tests required (no network to Fusion — inject `fetch`)

- `read_project_settings`: correct path, `projectId` scoping, token-free error.
- **Integration test**: start the HTTP server on an **ephemeral port** (`port: 0`)
  against a **mocked Fusion** (injected `fetch`), drive a real MCP client through
  Streamable HTTP: `initialize` → `tools/list` → `callTool get_board_health`,
  asserting a session id is issued and reused. Tear down cleanly (no leaked
  handles / open ports).

## Out of scope

Read tools (FM-001), write tools (FM-002), deploy/hardening (FM-004).

## Deliverable

PR against `Tchori-Labs/fusion-mcp` main, all five commands green. **Do not merge.**
