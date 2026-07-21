# Live MCP integration suite

The live suite is the sanctioned real-socket check for the built MCP server. It
drives real MCP clients over stdio and Streamable HTTP while talking to a
configured, self-hosted Fusion instance. It is separate from the mandatory
`pnpm test` suite: mandatory tests remain credential-free and load an
irreversible network guard, while `pnpm test:live` uses only
`vitest.live.config.ts`, which does not load that guard.

The journeys are read-only. They initialize MCP transports, inspect the tool
catalogue and health, list projects and project-scoped tasks, and read a task
when one is available. They never create or mutate tasks, change settings, or
invoke destructive or system operations.

## Prerequisites

1. Use Node 22 and install dependencies with `pnpm install --frozen-lockfile`.
2. Ensure the configured self-hosted Fusion instance is reachable from the test
   host.
3. The live instance must host **at least two projects**, with at least one
   readable task in the first two projects returned by `list_projects`. This is
   a hard release prerequisite, not a skippable condition: the gate must
   exercise task and task-subresource reads with explicit `projectId` values to
   detect multi-project scoping regressions.
4. Build the MCP server first with `pnpm build`. The live tests intentionally
   execute `dist/index.js` and fail with an actionable message when it is absent.
5. Obtain a live bearer token from the environment or an approved secret store.
   Never put credentials in source, fixtures, shell history, CI logs, or this
   file.

## Environment

| Variable                         | Required           | Default               | Live-suite behavior                                                                                                                                           |
| -------------------------------- | ------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FUSION_MCP_LIVE`                | yes                | unset                 | Explicit opt-in. Accepted truthy values are `1`, `true`, `yes`, and `on` (case-insensitive).                                                                  |
| `FUSION_BASE_URL`                | yes                | none for live tests   | Reachable base URL of the configured Fusion instance.                                                                                                         |
| `FUSION_TOKEN`                   | yes                | none                  | Bearer token supplied only through the environment or secret store. Captured traces redact its exact value.                                                   |
| `FUSION_DEFAULT_PROJECT_ID`      | no                 | unset                 | Passed through to the child server. The multi-project journey also starts a child with a selected project as its default and verifies omitted-input fallback. |
| `FUSION_CF_ACCESS_CLIENT_ID`     | with client secret | unset                 | Optional service-token client id inherited by the child when the live instance is behind an authenticating edge. Captured traces redact it.                   |
| `FUSION_CF_ACCESS_CLIENT_SECRET` | with client id     | unset                 | Optional service-token client secret inherited by the child. Captured traces redact it.                                                                       |
| `FUSION_USER_AGENT`              | no                 | unset                 | Optional upstream `User-Agent` override inherited by the child.                                                                                               |
| `PORT`                           | no                 | unused by the harness | Normal HTTP server setting. The HTTP live harness reserves and supplies its own free loopback port to avoid collisions.                                       |
| `FUSION_MCP_LIVE_ITERATIONS`     | no                 | `10`                  | Positive iteration count for each transport journey. The multi-project and authenticated-edge journeys run once to keep the release gate bounded.             |

All three primary conditions (`FUSION_MCP_LIVE`, `FUSION_BASE_URL`, and
`FUSION_TOKEN`) must be present. If local opt-in is false or either upstream
value is missing, every live file skips before opening a socket or spawning a
server and reports the unmet condition to stderr.

## Local invocation

Build, load the token without echoing it, and run the suite:

```bash
pnpm build
read -rsp "Fusion token: " FUSION_TOKEN && export FUSION_TOKEN && echo
FUSION_MCP_LIVE=1 \
  FUSION_BASE_URL="https://fusion.example.invalid" \
  FUSION_TOKEN="$FUSION_TOKEN" \
  pnpm test:live
```

## What the release gate verifies

- `list_projects` exposes at least two distinct projects;
- `list_tasks` succeeds independently with each explicit `projectId`, and any
  task-level project attribution matches the requested project;
- `get_task`, `get_task_logs`, and `get_task_workflow_results` succeed with the
  matching explicit project for a task, covering the task-subresource paths
  affected by #80; and
- a second child configured with `FUSION_DEFAULT_PROJECT_ID` returns the same
  task-id scope when `list_tasks` omits `projectId`, and the task-subresource
  reads also succeed through default-project fallback.

When the optional edge pair is configured, a separate single-pass project read
exercises the authenticated-edge request-header path. Missing headers cause the
edge request, and therefore the release gate, to fail.

Set `FUSION_MCP_LIVE_ITERATIONS` to a smaller positive
integer, for example `FUSION_MCP_LIVE_ITERATIONS=2`.

## Release-gate checklist

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm contract:check` are green.
- [ ] Mandatory `pnpm test` remains credential-free, loads the network guard,
      opens no socket, and loads no `*.live.test.ts` file.
- [ ] The protected `live-integration` environment points to a board with at
      least two projects and a readable task in one of the first two projects.
- [ ] Live stdio and HTTP transport journeys are green for 10 consecutive
      iterations.
- [ ] Explicit and default `projectId` multi-project reads are green.
- [ ] If the live board uses an authenticating edge, both CF Access mappings are
      configured and the authenticated-edge journey is green.
