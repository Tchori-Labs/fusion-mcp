# fusion-mcp

An [MCP](https://modelcontextprotocol.io) server that wraps the **Fusion**
agent-board REST API, so an MCP client (Claude Code, Claude Desktop, automation)
can run the board: watch it, triage, create tasks, comment on and steer running
agents, and read logs.

It is **governed by design**: there are deliberately **no** tools or workarounds
to merge PRs, approve plans, publish work, change settings, delete/archive tasks,
or restart the system. Fusion's automatic squash integration into `develop` is
internal board execution, not an MCP merge capability; reviewed `develop` →
`main` release PRs remain human-only. Writes are limited to task creation,
communication, and board reprioritisation. Every tool call is audited to stderr.
See [`SPEC.md`](./SPEC.md) for the full contract.

> Status: **the executable scaffold, all read tools, and the governed
> `create_task`, `comment_task`, `steer_task`, `pause_task`, `unpause_task`, and
> `move_task` write tools are implemented.** Future FM-00x work is tracked in
> [`briefs/`](./briefs) and integrated into `develop` through Fusion's automatic
> squash integration.

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `FUSION_BASE_URL` | no | `http://127.0.0.1:4040` | Base URL of the Fusion daemon. |
| `FUSION_TOKEN` | for non-health calls | — | Instance daemon bearer token (`fn_<hex>`). |
| `FUSION_DEFAULT_PROJECT_ID` | no | — | Project used when a tool omits `projectId`. |
| `PORT` | no | `4141` | HTTP transport port (loopback). |
| `FUSION_MCP_ALLOWED_HOSTS` | no | — | Additional exact `Host` values trusted behind a tunnel. |
| `FUSION_REQUEST_TIMEOUT_MS` | no | `15000` | Per-request timeout. |

The token is read from the environment only and is never logged or returned.

## Run modes

```bash
# stdio (default) — for local Claude Code / Desktop
node dist/index.js
node dist/index.js --stdio     # explicit

# Streamable HTTP — for deployment behind a tunnel
node dist/index.js --http      # serves http://127.0.0.1:$PORT/mcp
```

HTTP mode issues an `mcp-session-id` during initialization and reuses the same
server transport for subsequent POST and GET/SSE requests. Clients can terminate
their session with DELETE; SIGINT and SIGTERM stop the listener and close all
remaining sessions gracefully. The listener remains loopback-only and validates
exact `Host` values to prevent DNS rebinding.

Register with Claude Code (stdio):

```json
{
  "mcpServers": {
    "fusion": {
      "command": "node",
      "args": ["/path/to/fusion-mcp/dist/index.js", "--stdio"],
      "env": { "FUSION_TOKEN": "fn_…" }
    }
  }
}
```

## Tools

Implemented: `get_board_health` · `list_projects` · `read_project_settings` ·
`list_tasks` · `get_task` · `get_task_logs` · `get_task_workflow_results` ·
`create_task` · `comment_task` · `steer_task` · `pause_task` · `unpause_task` ·
`list_approvals` · `get_approval` · `list_missions` · `get_mission` ·
`move_task` (board reprioritisation only).

### Governed task writes

- `create_task` requires `description` and accepts only `title`, `column`,
  `priority`, `dependencies`, `workflowId`, `baseBranch`, and `projectId` as
  optional fields. Resolved project scope is sent in the POST body, never the
  query string.
- `comment_task` requires `id` and non-empty `text`, with optional `author`.
- `steer_task` requires `id` and `text` of 1–2000 characters.
- `pause_task` and `unpause_task` require only `id` and send body-free POSTs to
  the corresponding encoded task endpoint.
- `move_task` requires `id` and `column`, accepts optional `projectId`, and is
  limited to moving a task between board columns for reprioritisation.

Project-scoped read tools take an optional `projectId`; `get_board_health` and
`list_projects` are instance-scoped. Write tools are limited to governed task
creation, communication, and board reprioritisation. Audits contain only safe
metadata selected per tool, such as task or project ids, create-task titles,
column names, and pagination bounds; full message bodies and tokens are never
logged. Full parameter and endpoint mapping is in
[`SPEC.md`](./SPEC.md#tool-catalogue).

## Branching & releases

- **`develop`** is the default integration branch. Fusion cuts task worktrees
  from `develop` and automatically squash-integrates completed work back into
  it; agents do not open PRs or choose the target branch.
- **`main`** is the protected, release-only line. It changes solely through a
  human-reviewed `develop` → `main` PR plus a version tag at release time.
- Releases are human-only: a human opens, reviews, and merges the release PR,
  then creates the version tag. The MCP server cannot perform these actions.

## Development

Requires Node 22 (`.nvmrc`) and pnpm.

```bash
pnpm install
pnpm lint         # eslint (flat config)
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest (hermetic guard blocks TCP/TLS/HTTP(S)/DNS)
pnpm test:stability # 10 fresh-process hermetic repetitions for flake detection
pnpm build          # tsc → dist/
pnpm dev          # tsx src/index.ts --stdio
```

When a governed tool or input schema changes, run `pnpm contract:generate`,
review the `tool-contract.json` diff, and commit the generated file. Generation
preserves prior same-major baselines and rejects breaking or ungoverned changes;
do not edit or remove manifest history by hand. See
[`docs/tool-contract-versioning.md`](./docs/tool-contract-versioning.md) for the
compatibility and deprecation policy.

CI runs all of the above as the required **Build & Test** check. The mandatory
suite's guard has no bypass. Tests named `*.live.test.ts` are excluded from
`pnpm test` and may run only as opt-in live checks through a separate, explicit
Vitest config that does not load the guard. For repeat-run flake detection, use
`pnpm test:stability` and follow the [stability burn-in runbook](./docs/stability.md).

### Live integration suite (opt-in)

After `pnpm build`, `pnpm test:live` can exercise real MCP clients over stdio and
Streamable HTTP when explicitly enabled with live instance credentials. See the
[runbook and release checklist](./docs/live-integration.md) for exact gating,
invocation, isolation, cleanup, and secret-handling instructions.

Contributor rules — including the cross-repo / no-merge protocol — are in
[`AGENTS.md`](./AGENTS.md).

## License

MIT © Tchori Labs — see [`LICENSE`](./LICENSE).
