# fusion-mcp — Specification

## Purpose

`fusion-mcp` is an external [Model Context Protocol](https://modelcontextprotocol.io)
server that wraps the REST API of **Fusion** — a self-hosted, AI-agent task-board
product that cuts task worktrees from `develop` and automatically
squash-integrates completed work back into `develop`. The MCP server lets an MCP
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
   plan, enable auto-merge, or otherwise publish work outside the board. Fusion
   automatically squash-integrates completed task work into `develop`; that is
   internal board execution, and this server exposes no tool or workaround to
   trigger, approve, or publish it. Releasing `develop` to the protected `main`
   branch requires a human-reviewed PR and version tag; there is no MCP tool for
   it. Merging release PRs, approving plans, and publishing remain human actions.
2. **No settings mutation.** Project/instance settings are **read-only** through
   this server. There is no tool to change settings.
3. **No destructive task ops.** No delete, no archive, no bulk mutation.
4. **No system control.** No restart, no shutdown, no daemon control.
5. **Writes are scoped to task creation, task communication, and board
   reprioritisation only** — create a task, comment, steer, pause, unpause,
   and move a task between columns (`move_task`). No other mutation exists.
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
| `list_approvals` | read | `projectId?: string` | `GET /api/approvals` |
| `get_approval` | read | `id: string`, `projectId?: string` | `GET /api/approvals/:id` |
| `list_missions` | read | `projectId?: string`, `includeDrafts?: boolean` | `GET /api/missions` |
| `get_mission` | read | `id: string`, `projectId?: string` | `GET /api/missions/:id` (+ `/status`, `/health` folded into the result) |
| `move_task` | write | `id: string`, `column: string`, `projectId?: string` | `POST /api/tasks/:id/move` |

`create_task` exposes only the safe parameter subset above; other fields the
Fusion API may accept are intentionally not surfaced.

The approvals and missions tools are strictly read-only: the approval
*decision* endpoint and every mission mutation (create/edit/autopilot/
planning-start) are deliberately not wrapped — deciding and steering the
hierarchy stay human. `move_task` is the one write beyond
creation/communication: board reprioritisation only, approved as a
deliberate governance-surface expansion (2026-07-17).

**Implementation status:** `get_board_health`, `list_projects`,
`read_project_settings`, `list_tasks`, `get_task`, `get_task_logs`, and
`get_task_workflow_results` are implemented. The original write set
(`create_task`, `comment_task`, `steer_task`, `pause_task`, `unpause_task`)
is delivered by tasks FM-001 … FM-004 (see `briefs/`) on top of the existing
`FusionClient`. `list_approvals`, `get_approval`, `list_missions`,
`get_mission`, and `move_task` were added by the human-approved 2026-07-17
spec change and are delivered by their own board tasks.

### Tool contract compatibility

[`tool-contract.json`](./tool-contract.json) is the generated, append-only
history of compatibility baselines for implemented tool names, their MCP input
JSON Schemas, and the canonical error envelope and stable error-code meanings.
CI compares the live in-memory MCP surface and error contract with every baseline
in the current package major and rejects breaking drift. Tool names and top-level
input properties must both appear in this catalogue; ungoverned additions always
fail. Governed additive changes are permitted, while intentional breaks require
a new major baseline. The versioning, deprecation, and
regenerate-don't-hand-edit policy is documented in
[`docs/tool-contract-versioning.md`](./docs/tool-contract-versioning.md).

## Error contract

Every governed tool failure is returned as an MCP tool result with `isError:
true`. The first text content item contains this canonical JSON envelope:

```json
{
  "error": {
    "code": "upstream_error",
    "message": "Upstream request failed",
    "status": 503
  }
}
```

`status` and `details` are optional. `status` appears only for
`upstream_error` or `invalid_upstream_payload`, and only when a valid upstream
HTTP status is known. `details` contains independently sanitized structured
context (currently validation issue paths and fixed diagnostics) and may gain
additive fields over time. Validation paths expose only field names derived from
the registered input schema; unknown string segments and all numeric segments
are redacted. Custom schema/refinement paths and messages are untrusted and are
never copied verbatim into the envelope. Upstream exception messages, methods,
and paths are not copied into the public result; each non-validation class uses
a fixed safe message. Successful tool result shapes are unaffected.

The exhaustive stable error codes are:

| Code | Meaning |
| --- | --- |
| `validation` | Tool arguments did not satisfy the tool's input schema. |
| `missing_token` | An authenticated operation was called without a configured token. |
| `upstream_error` | Fusion returned a non-success status or the request failed at the transport layer. |
| `timeout` | The request exceeded the configured upstream timeout. |
| `invalid_upstream_payload` | Fusion returned a success response whose payload could not be safely decoded or validated. |
| `internal` | An unexpected internal failure occurred; its message is deliberately generic. |

All six codes and their meanings are part of a public, compatibility-sensitive
contract. Removing or renaming a code, or changing its meaning, is a breaking
change and must follow the versioning and deprecation policy. The generated
`tool-contract.json` records the envelope and code meanings, and same-major
compatibility checks reject their removal or incompatible change. The token,
upstream response bodies, raw received argument values, exception metadata, and
stack traces never appear in any envelope field. In particular, `internal`
always uses a fixed generic message.

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

Runs **alongside the Fusion daemon on the same host** (as a service managed by
the same container platform), talking to it over loopback/internal networking
(`http://127.0.0.1:4040`), so the token never crosses the public network in the
hot path.

1. Build (`pnpm build`) and ship `dist/` + `node_modules` (or install on the box).
2. A `systemd` unit runs `node dist/index.js --http` with an `EnvironmentFile`
   holding `FUSION_BASE_URL`, `FUSION_TOKEN`, `FUSION_DEFAULT_PROJECT_ID`, `PORT`.
   The token is provisioned via `fn daemon --token-only` and written to a
   root-only env file (`0600`).
3. The HTTP transport binds to loopback only. Public exposure is via an
   **access-controlled tunnel** in front of `127.0.0.1:$PORT`, with authentication
   enforced by an access proxy. No port is opened on the host firewall.
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
- **Hermetic enforcement:** the mandatory `vitest.config.ts` loads a global
  guard through `setupFiles` that fails outbound TCP, TLS, UDP, HTTP(S), and DNS
  attempts immediately. Tests named `*.live.test.ts` are excluded from the
  mandatory suite and belong only in the opt-in live suite under its own
  explicit config, which must omit the guard; the mandatory gate has no bypass,
  allowlist, or environment-controlled escape hatch.
- **Layers under test in the scaffold:**
  - `config.test.ts` — defaults, overrides, trailing-slash normalisation, blank
    optionals collapsing to unset, invalid URL/port rejection, `requireToken`.
  - `fusion-client.test.ts` — bearer header attachment, `undefined` query
    dropping, JSON body + content-type, pagination header exposure, token-free
    error normalisation on non-2xx and transport failure, timeout behaviour,
    auth-exempt health.
  - `health-tool.test.ts` — end-to-end through an in-memory MCP client/server
    pair (`InMemoryTransport.createLinkedPair()`): asserts the tool set is
    exactly `[get_board_health, list_tasks]` (governance), and the health/system
    merge with and without a token.
- **FM tasks** add tests alongside each new tool: projectId scoping, pagination
  edges, input-validation failures, and (FM-003) an integration test that spins
  the HTTP server on an ephemeral port against a mocked Fusion.
- CI gate: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` (job
  **Build & Test**).
