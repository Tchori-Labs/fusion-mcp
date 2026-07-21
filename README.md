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
> `move_task` write tools are implemented.** Further work is integrated into
> `develop` through Fusion's automatic squash integration.

## Installation

Requires Node.js 22 or newer.

```bash
pnpm add @tchori-labs/fusion-mcp
```

Or run it on demand without installing:

```bash
npx @tchori-labs/fusion-mcp --stdio
```

The package installs a `fusion-mcp` executable that speaks MCP over stdio by
default, so most MCP clients can launch it directly — see
[MCP client configuration](#mcp-client-configuration).

## Configuration

Point the server at **your Fusion instance** with `FUSION_BASE_URL` and
authenticate with `FUSION_TOKEN`. All configuration is via environment
variables:

| Variable                         | Required             | Default                 | Meaning                                                     |
| -------------------------------- | -------------------- | ----------------------- | ----------------------------------------------------------- |
| `FUSION_BASE_URL`                | no                   | `http://127.0.0.1:4040` | Base URL of the Fusion daemon.                              |
| `FUSION_TOKEN`                   | for non-health calls | —                       | Instance daemon bearer token (`fn_<hex>`).                  |
| `FUSION_DEFAULT_PROJECT_ID`      | no                   | —                       | Project used when a tool omits `projectId`.                 |
| `FUSION_CF_ACCESS_CLIENT_ID`     | with client secret   | —                       | Service-token client id sent to an authenticating edge.     |
| `FUSION_CF_ACCESS_CLIENT_SECRET` | with client id       | —                       | Service-token client secret sent to an authenticating edge. |
| `FUSION_USER_AGENT`              | no                   | —                       | Overrides the `User-Agent` on upstream board requests.      |
| `PORT`                           | no                   | `4141`                  | HTTP transport port (loopback).                             |
| `FUSION_MCP_ALLOWED_HOSTS`       | no                   | —                       | Additional exact `Host` values trusted behind a tunnel.     |
| `FUSION_REQUEST_TIMEOUT_MS`      | no                   | `15000`                 | Per-request timeout.                                        |

Credentials are read from the environment only and are never logged or returned.
The Access client id and secret must be set together; blank values are treated as
unset.

## Run modes

```bash
# stdio (default) — for local Claude Code / Desktop
node dist/index.js
node dist/index.js --stdio     # explicit

# Streamable HTTP — for deployment behind a tunnel
node dist/index.js --http      # serves http://127.0.0.1:$PORT/mcp
```

For a board fronted by an authenticating edge or Zero Trust access proxy, set
both `FUSION_CF_ACCESS_CLIENT_ID` and `FUSION_CF_ACCESS_CLIENT_SECRET`. The pair
is sent on every upstream board request, including health checks. Set
`FUSION_USER_AGENT` only when the edge policy requires a specific agent string.

HTTP mode issues an `mcp-session-id` during initialization and reuses the same
server transport for subsequent POST and GET/SSE requests. Clients can terminate
their session with DELETE; SIGINT and SIGTERM stop the listener and close all
remaining sessions gracefully. The listener remains loopback-only and validates
exact `Host` values to prevent DNS rebinding.

## MCP client configuration

Configure your MCP client to launch the server over stdio. With the package
installed (or resolvable through `npx`), point it at your Fusion instance via
the environment:

```json
{
  "mcpServers": {
    "fusion": {
      "command": "npx",
      "args": ["-y", "@tchori-labs/fusion-mcp", "--stdio"],
      "env": {
        "FUSION_BASE_URL": "https://fusion.example.com",
        "FUSION_TOKEN": "fn_…"
      }
    }
  }
}
```

Contributors running from a local checkout can instead invoke the built entry
point directly with `"command": "node"` and
`"args": ["/path/to/fusion-mcp/dist/index.js", "--stdio"]`.

## Tools

Implemented: `get_board_health` · `list_projects` · `read_project_settings` ·
`list_tasks` · `get_task` · `get_task_logs` · `get_task_workflow_results` ·
`create_task` · `comment_task` · `steer_task` · `pause_task` · `unpause_task` ·
`list_approvals` · `get_approval` · `list_missions` · `get_mission` ·
`move_task` (board reprioritisation only).

`get_task_logs` and `get_task_workflow_results` require `id` and accept optional
`projectId` for task lookup; `get_task_logs` also accepts pagination bounds.

### Governed task writes

- `create_task` requires `description` and accepts only `title`, `column`,
  `priority`, `dependencies`, `workflowId`, `baseBranch`, and `projectId` as
  optional fields. Resolved project scope is sent in the POST body, never the
  query string.
- `comment_task` requires `id` and non-empty `text`, with optional `author` and
  `projectId`.
- `steer_task` requires `id` and `text` of 1–2000 characters, with optional
  `projectId`.
- `pause_task` and `unpause_task` require `id` and accept optional `projectId`.
  They send the resolved project scope in the POST body, while an unresolved
  scope preserves the body-free request.
- `move_task` requires `id` and `column`, accepts optional `projectId`, and is
  limited to moving a task between board columns for reprioritisation.

Project- and task-scoped tools take an optional `projectId`; `get_board_health`
and `list_projects` are instance-scoped. Task-scoped GET requests send resolved
scope in the query string, while POST requests send it in the body. Write tools
remain limited to governed task creation, communication, and board
reprioritisation. Audits contain only safe
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
