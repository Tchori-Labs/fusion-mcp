# fusion-mcp

An [MCP](https://modelcontextprotocol.io) server that wraps the **Fusion**
agent-board REST API, so an MCP client (Claude Code, Claude Desktop, automation)
can run the board: watch it, triage, create tasks, comment on and steer running
agents, and read logs.

It is **governed by design**: there are deliberately **no** tools to merge PRs,
approve plans, change settings, delete/archive tasks, or restart the system.
Writes are limited to task creation and communication. Every tool call is audited
to stderr. See [`SPEC.md`](./SPEC.md) for the full contract.

> Scaffold status: only `get_board_health` is implemented today (proof-of-life).
> The remaining tools land via the FM-00x tasks in [`briefs/`](./briefs).

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

`get_board_health` (implemented) · `list_projects` · `list_tasks` · `get_task` ·
`get_task_logs` · `get_task_workflow_results` · `read_project_settings` ·
`create_task` · `comment_task` · `steer_task` · `pause_task` · `unpause_task`.

Read tools take an optional `projectId`; write tools are scoped to task
creation/communication. Full parameter and endpoint mapping is in
[`SPEC.md`](./SPEC.md#tool-catalogue).

## Development

Requires Node 22 (`.nvmrc`) and pnpm.

```bash
pnpm install
pnpm lint         # eslint (flat config)
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest (no network — fetch is injected/mocked)
pnpm build        # tsc → dist/
pnpm dev          # tsx src/index.ts --stdio
```

CI runs all of the above as the required **Build & Test** check. Contributor
rules — including the cross-repo / no-merge protocol — are in
[`AGENTS.md`](./AGENTS.md).

## License

MIT © Tchori Labs — see [`LICENSE`](./LICENSE).
