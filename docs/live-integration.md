# Live MCP integration suite

The live suite is the sanctioned real-socket check for the built MCP server. It
drives a real MCP client over stdio and Streamable HTTP while talking to a
configured, self-hosted Fusion instance. It is intentionally separate from the
mandatory `pnpm test` suite: mandatory tests remain credential-free and load an
irreversible network guard, while `pnpm test:live` uses only
`vitest.live.config.ts`, which does not load that guard.

The journeys are read-only. Each transport performs MCP initialization,
`tools/list`, and `get_board_health`; it does not create or mutate tasks, write
settings, or invoke destructive or system operations.

## Prerequisites

1. Use Node 22 and install dependencies with `pnpm install --frozen-lockfile`.
2. Ensure the configured self-hosted Fusion instance is reachable from the test
   host.
3. Build the MCP server first with `pnpm build`. The live tests intentionally
   execute `dist/index.js` and fail with an actionable message when it is absent.
4. Obtain a live bearer token from the environment or an approved secret store.
   Never put the token in source, fixtures, shell history, CI logs, or this file.

## Environment

| Variable | Required | Default | Live-suite behavior |
| --- | --- | --- | --- |
| `FUSION_MCP_LIVE` | yes | unset | Explicit opt-in. Accepted truthy values are `1`, `true`, `yes`, and `on` (case-insensitive). |
| `FUSION_BASE_URL` | yes | none for live tests | Reachable base URL of the configured Fusion instance. |
| `FUSION_TOKEN` | yes | none | Bearer token supplied only through the environment or secret store. Captured traces redact its exact value. |
| `FUSION_DEFAULT_PROJECT_ID` | no | unset | Passed through to the child server; the health journey itself is instance-scoped. |
| `PORT` | no | unused by the harness | Normal HTTP server setting. The HTTP live harness reserves and supplies its own free loopback port to avoid collisions. |
| `FUSION_MCP_LIVE_ITERATIONS` | no | `10` | Positive integer iteration count for each transport journey. |

All three required conditions must be present. If the opt-in is false or either
upstream value is missing, every live suite skips before opening a socket or
spawning a server and prints the unmet condition to stderr.

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

Replace the example URL with the reachable instance URL. Do not use shell
tracing (`set -x`) around secret setup. To confirm the safe gate independently:

```bash
env -u FUSION_MCP_LIVE -u FUSION_BASE_URL -u FUSION_TOKEN pnpm test:live
pnpm test
```

The first command must report both live files skipped. The second remains the
mandatory socket-free suite and must not load either live file.

## What is verified

For both stdio and HTTP, each iteration verifies:

- a real MCP `Client` completes initialize, `tools/list`, and
  `get_board_health`;
- the implemented governed tool catalogue is returned;
- the health result is JSON text with a `health` field;
- the health audit line is on child stderr, not stdout;
- the token is absent from captured stdout and stderr; and
- the client and transport close without leaving a child process.

The HTTP journey additionally verifies that the issued `mcp-session-id` remains
unchanged across multiple requests, explicit DELETE teardown logs the matching
session close, and SIGTERM closes an active session and exits cleanly without a
forced kill.

## Ten consecutive runs

One `pnpm test:live` invocation performs **10 consecutive iterations of each
transport journey** by default. This is the release acceptance procedure:

```bash
FUSION_MCP_LIVE=1 \
  FUSION_BASE_URL="$FUSION_BASE_URL" \
  FUSION_TOKEN="$FUSION_TOKEN" \
  pnpm test:live
```

For diagnosis, override the count with a positive integer, for example
`FUSION_MCP_LIVE_ITERATIONS=2`. If a reviewer prefers 10 fresh Vitest processes
rather than one process containing 10 iterations, run:

```bash
for run in $(seq 1 10); do
  echo "live process run $run/10"
  FUSION_MCP_LIVE=1 \
    FUSION_MCP_LIVE_ITERATIONS=1 \
    FUSION_BASE_URL="$FUSION_BASE_URL" \
    FUSION_TOKEN="$FUSION_TOKEN" \
    pnpm test:live || exit 1
done
```

## CI invocation

Do not add `pnpm test:live` to the required **Build & Test** check. A CI live run
must be a separate, non-required, manually dispatched job with network access.
Store `FUSION_TOKEN` in the CI secret store, mask it, map it directly into the
job environment, and gate the job on the availability of both the secret and a
reachable `FUSION_BASE_URL`. Run `pnpm install --frozen-lockfile`, `pnpm build`,
and then the same `pnpm test:live` command shown above.

Never print the environment, enable shell tracing, upload unredacted process
output, or make the live job a release-branch protection requirement.

## Isolation, traces, and cleanup

The suite uses only `tools/list` and the side-effect-free
`get_board_health` read. The stdio transport owns and closes its child. The HTTP
harness reserves a free loopback port, explicitly deletes each MCP session, and
sends SIGTERM to the server after verifying graceful active-session cleanup.
Test cleanup has a forced-kill fallback only to prevent an already-failed test
from orphaning its own child; a successful run never needs that fallback.

On failure, the suite writes a mode-`0600` trace under the operating system's
temporary directory and prints its path as:

```text
fusion-mcp live failure trace (redacted): /tmp/fusion-mcp-…log
```

The trace separates captured stdout, stderr, and a redacted failure summary.
The exact token value is replaced with `[REDACTED]` before the file is written.
Inspect the path for transport and lifecycle diagnostics, then remove it after
review:

```bash
rm -- /tmp/fusion-mcp-…log
```

Also confirm no child `dist/index.js` process remains and the temporary HTTP
port is closed. Never attach a trace until it has been checked again for secrets.

## Release checklist

- [ ] `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`,
      `pnpm test`, and `pnpm build` are green.
- [ ] Mandatory `pnpm test` remains credential-free, loads the network guard,
      opens no socket, and loads no `*.live.test.ts` file.
- [ ] Live stdio is green for 10 consecutive iterations against the configured
      self-hosted instance.
- [ ] Live HTTP is green for 10 consecutive iterations, including session reuse,
      DELETE teardown, active-session SIGTERM cleanup, and clean exit.
- [ ] Audit diagnostics were observed only on stderr; child stdout remained
      protocol-only for stdio and empty for HTTP.
- [ ] The token appears in no captured stream, failure, trace, or uploaded
      artifact.
- [ ] No child process, session, or loopback listener remains after the run.
- [ ] The governed tool catalogue and all governance invariants are unchanged.
- [ ] Any release pull request targets only this repository's `main` branch and
      is left unmerged for human review.
