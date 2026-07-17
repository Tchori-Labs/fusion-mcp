# fusion-mcp — Specification

## Purpose

`fusion-mcp` is an external [Model Context Protocol](https://modelcontextprotocol.io)
server that wraps the REST API of **Fusion** — a self-hosted, AI-agent task-board
product (agents pick up tasks, run, and open PRs). The MCP server lets an MCP
client (Claude Code, Claude Desktop, or an automation) act as the *operational
brain* of a Fusion board: watch columns, triage, create and prioritise tasks,
comment on and steer running agents, pause/unpause work, and read logs.

It is deliberately a **thin, governed** wrapper. It does not embed board policy,
it does not persist state, and it exposes a curated subset of Fusion's API — not
the whole surface.

## Governance invariants (design invariant — do not weaken)

These are the reason the project exists in this shape. They are enforced by
*what tools exist*, not by runtime policy checks:

1. **No merge / approve / publish.** There is no tool to merge a PR, approve a
   plan, enable auto-merge, or otherwise publish work outside the board. Fusion's
   own auto-merge stays off; merge is a human action.
2. **No settings mutation.** Project/instance settings are **read-only** through
   this server. There is no tool to change settings.
3. **No destructive task ops.** No delete, no archive, no bulk mutation.
4. **No system control.** No restart, no shutdown, no daemon control.
5. **Writes are scoped to task creation and communication only** — create a task,
   comment, steer, pause, unpause. Nothing else.
6. **Every tool call is audited** to stderr: timestamp, tool name, and a
   secret-free argument summary.
7. **Secrets never appear in output.** The token comes from the environment only
   and is never echoed in errors, logs, or tool results.

Adding a tool that violates 1–5 is a spec change, not a feature.

## Architecture

Three thin layers, each independently testable:

```
env ─▶ config.ts ─▶ FusionClient (fetch wrapper) ─▶ MCP tools ─▶ transport (stdio | http)
        parse/validate   bearer auth, query/JSON,     zod-validated    Claude / automation
                         timeout, error normalise      thin handlers
```

- **`config.ts`** — parses and validates the environment once into a `Config`.
  Provides `requireToken(config)` so authenticated tools fail loudly and clearly
  when no token is set, while health-only deployments still start.
- **`fusion-client.ts`** — a small `fetch` wrapper (`FusionClient`). One core
  `request<T>(method, path, opts)` primitive adds bearer auth, query
  serialisation (dropping `undefined`), JSON handling, a per-request
  `AbortController` timeout, and **token-free** error normalisation
  (`FusionError` with `method`, `path`, `status`). Endpoint-specific helpers are
  built on top of `request`. The response object exposes `headers` so pagination
  metadata (`X-Total-Count` / `X-Has-More`) is available to tools.
- **MCP tools** — each tool is a thin handler: validate input (zod), call one or
  two client methods, shape a compact result. Registered via
  `server.registerTool(name, config, handler)` on `McpServer` from
  `@modelcontextprotocol/sdk`.

The client is intentionally untyped at the domain level (`unknown` payloads) in
the scaffold; the FM tasks may introduce response types as needed, but must not
turn the client into a fat SDK.

## Auth model

- Fusion uses a single **instance-wide daemon token**: `Authorization: Bearer
  fn_<hex>`. The same token authorises the dashboard and the headless
  `fn daemon`. There is no per-user auth at this layer.
- `GET /api/health` is **auth-exempt** and is the only endpoint callable without
  a token. Every other endpoint requires the bearer header.
- The token is read from `FUSION_TOKEN` and held only in memory. It is attached
  as a header per request and never logged or returned.
- Multi-project scoping: an optional `projectId` is a **query param on GET** and a
  **body field on POST**. Omitted ⇒ the server's default project. The MCP layer
  applies `FUSION_DEFAULT_PROJECT_ID` when a tool call omits `projectId`.

## Configuration (environment)

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `FUSION_BASE_URL` | no | `http://127.0.0.1:4040` | Base URL of the Fusion daemon (trailing slash stripped). |
| `FUSION_TOKEN` | for any non-health call | — | Instance daemon bearer token (`fn_<hex>`). Blank ⇒ treated as unset. |
| `FUSION_DEFAULT_PROJECT_ID` | no | — | Project applied when a tool omits `projectId`. |
| `PORT` | no | `4141` | HTTP transport listen port (loopback). Ignored in stdio mode. |
| `FUSION_REQUEST_TIMEOUT_MS` | no | `15000` | Per-request timeout for the Fusion client. |

## Tool catalogue

Project-scoped read tools accept an optional `projectId`; `get_board_health`
and `list_projects` are instance-scoped. Write tools are scoped strictly to task
creation/communication.

| Tool | Class | Params (type) | Backing endpoint |
| --- | --- | --- | --- |
| `get_board_health` | read | *(none)* | `GET /api/health` + `GET /api/system/info` |
| `list_projects` | read | *(none)* | `GET /api/projects` |
| `list_tasks` | read | `projectId?: string`, `limit?: number`, `offset?: number`, `q?: string`, `column?: string`, `includeArchived?: boolean` | `GET /api/tasks` |
| `get_task` | read | `id: string`, `projectId?: string` | `GET /api/tasks/:id` |
| `get_task_logs` | read | `id: string`, `limit?: number`, `offset?: number` | `GET /api/tasks/:id/logs` (reads `X-Total-Count` / `X-Has-More`) |
| `get_task_workflow_results` | read | `id: string` | `GET /api/tasks/:id/workflow-results` |
| `read_project_settings` | read | `projectId?: string` | `GET /api/settings` |
| `create_task` | write | `description: string` (req), `title?: string`, `column?: string`, `priority?: string`, `dependencies?: string[]`, `workflowId?: string`, `baseBranch?: string`, `projectId?: string` | `POST /api/tasks` |
| `comment_task` | write | `id: string`, `text: string`, `author?: string` | `POST /api/tasks/:id/comments` |
| `steer_task` | write | `id: string`, `text: string` (1–2000 chars) | `POST /api/tasks/:id/steer` |
| `pause_task` | write | `id: string` | `POST /api/tasks/:id/pause` |
| `unpause_task` | write | `id: string` | `POST /api/tasks/:id/unpause` |

`create_task` exposes only the safe parameter subset above; other fields the
Fusion API may accept are intentionally not surfaced.

**Implementation status:** `get_board_health`, `list_projects`, and
`read_project_settings` are implemented. The remaining tools are delivered by
tasks FM-001 … FM-004 (see `briefs/`) on top of the existing `FusionClient`.

## Transports

- **stdio** (default) — for local use with Claude Code / Desktop. Started with no
  flag, or `--stdio` for clarity.
- **Streamable HTTP** (`--http`) — for deployment behind a tunnel. The scaffold
  ships a minimal **stateless** implementation (fresh server + transport per
  request, JSON responses, bound to `127.0.0.1:$PORT/mcp`). FM-003 hardens this
  with per-session handling (`mcp-session-id`), graceful shutdown, and audit
  logging integration.

## Audit logging

`auditLog(tool, argsSummary)` writes one line per tool call to **stderr**:

```
[2026-07-13T18:03:51.993Z] tool=get_board_health
[2026-07-13T18:04:10.101Z] tool=create_task title=Fix login column=todo
```

Argument summaries include only non-sensitive identifiers (ids, titles, columns,
limits) — never token or full free-text bodies. stdout is reserved for the MCP
stdio protocol, so all diagnostics go to stderr.

## Deployment sketch

Runs on the **same LXC as the Fusion daemon**, talking to it over loopback
(`http://127.0.0.1:4040`), so the token never crosses the network in the hot path.

1. Build (`pnpm build`) and ship `dist/` + `node_modules` (or install on the box).
2. A `systemd` unit runs `node dist/index.js --http` with an `EnvironmentFile`
   holding `FUSION_BASE_URL`, `FUSION_TOKEN`, `FUSION_DEFAULT_PROJECT_ID`, `PORT`.
   The token is provisioned via `fn daemon --token-only` and written to a
   root-only env file (`0600`).
3. The HTTP transport binds to loopback only. Public exposure is via a
   **Cloudflare Tunnel** in front of `127.0.0.1:$PORT`, gated by **Cloudflare
   Access** (same pattern as the rest of the Tchori infra). No port is opened on
   the host firewall.
4. Liveness: `GET /api/health` on Fusion, plus the MCP server's own process
   supervision by systemd (`Restart=on-failure`).

FM-004 delivers `docs/deploy.md` with the concrete unit file and env template.

## Testing strategy

- **Runner:** vitest, `environment: node`, `include: src/**/*.test.ts`.
- **No network, ever.** The Fusion client takes an injectable `fetch`
  (`FetchLike = (url: string, init?: RequestInit) => Promise<Response>`).
  Unit tests pass a `vi.fn()` returning constructed `Response` objects. As an
  alternative, `undici`'s `MockAgent` + `setGlobalDispatcher` can intercept the
  global fetch, but plain injection is the default because it needs no extra
  dependency and pins the exact call arguments.
- **Layers under test in the scaffold:**
  - `config.test.ts` — defaults, overrides, trailing-slash normalisation, blank
    optionals collapsing to unset, invalid URL/port rejection, `requireToken`.
  - `fusion-client.test.ts` — bearer header attachment, `undefined` query
    dropping, JSON body + content-type, pagination header exposure, token-free
    error normalisation on non-2xx and transport failure, timeout behaviour,
    auth-exempt health.
  - `health-tool.test.ts` — end-to-end through an in-memory MCP client/server
    pair (`InMemoryTransport.createLinkedPair()`): asserts the tool set is
    exactly `[get_board_health]` (governance), and the health/system merge with
    and without a token.
- **FM tasks** add tests alongside each new tool: projectId scoping, pagination
  edges, input-validation failures, and (FM-003) an integration test that spins
  the HTTP server on an ephemeral port against a mocked Fusion.
- CI gate: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` (job
  **Build & Test**).
