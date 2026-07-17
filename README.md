# fusion-mcp

An [MCP](https://modelcontextprotocol.io) server that wraps the **Fusion**
agent-board REST API, so an MCP client (Claude Code, Claude Desktop, automation)
can run the board: watch it, triage, create tasks, comment on and steer running
agents, and read logs.

It is **governed by design**: there are deliberately **no** tools to merge PRs,
approve plans, change settings, delete/archive tasks, or restart the system.
Writes are limited to task creation and communication. Every tool call is audited
to stderr. See [`SPEC.md`](./SPEC.md) for the full contract.

> Status: **the executable scaffold, `get_board_health`, `list_projects`, and
> `read_project_settings` are implemented.** The remaining catalogue tools are
> future FM-00x work in [`briefs/`](./briefs), delivered as separate
> human-reviewed PRs.

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `FUSION_BASE_URL` | no | `http://127.0.0.1:4040` | Base URL of the Fusion daemon. |
| `FUSION_TOKEN` | for non-health calls | — | Instance daemon bearer token (`fn_<hex>`). |
| `FUSION_DEFAULT_PROJECT_ID` | no | — | Project used when a tool omits `projectId`. |
| `PORT` | no | `4141` | HTTP transport port (loopback). |
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

Implemented: `get_board_health` · `list_projects` · `read_project_settings`.

Planned: `list_tasks` · `get_task` · `get_task_logs` ·
`get_task_workflow_results` · `create_task` · `comment_task` · `steer_task` ·
`pause_task` · `unpause_task`.

Project-scoped read tools take an optional `projectId`; `get_board_health` and
`list_projects` are instance-scoped. Write tools are scoped to task
creation/communication. Full parameter and endpoint mapping is in
[`SPEC.md`](./SPEC.md#tool-catalogue).

## Development

Requires Node 22 (`.nvmrc`) and pnpm.

```bash
pnpm install
pnpm lint         # eslint (flat config)
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest (hermetic guard blocks TCP/TLS/HTTP(S)/DNS)
pnpm build        # tsc → dist/
pnpm dev          # tsx src/index.ts --stdio
```

CI runs all of the above as the required **Build & Test** check. The mandatory
suite's guard has no bypass; opt-in live checks use a separate Vitest config
that does not load it. Contributor rules — including the cross-repo / no-merge
protocol — are in [`AGENTS.md`](./AGENTS.md).

## License

MIT © Tchori Labs — see [`LICENSE`](./LICENSE).
