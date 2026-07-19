# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-07-19

### Fixed

- The CLI now starts when launched through the package manager's
  `node_modules/.bin` symlink (as `npx` does); the direct-execution guard
  previously failed to match the symlinked entry path and the process exited
  silently.

## [0.1.0] - 2026-07-19

### Added

- Initial governed MCP server scaffold with environment validation, authenticated
  REST requests, secret-safe audit logging, and stdio transport.
- Seven read tools: `get_board_health`, `list_tasks`, `get_task`,
  `get_task_logs`, `get_task_workflow_results`, `list_projects`, and
  `read_project_settings`.
- Five governed task-write tools: `create_task`, `comment_task`, `steer_task`,
  `pause_task`, and `unpause_task`, limited to the safe creation and
  communication surface defined by the specification.
- Stateful Streamable HTTP transport with session reuse, GET/SSE streaming,
  explicit DELETE teardown, and graceful SIGINT/SIGTERM shutdown.
- Generated, append-only `tool-contract.json` baselines covering tool names,
  input schemas, and the public error envelope, with compatibility enforcement
  in the required test suite.
- Opt-in live end-to-end journeys for stdio and Streamable HTTP through
  `pnpm test:live`, kept separate from the mandatory socket-free tests.
- Read-only `list_approvals` and `get_approval` tools for inspecting board
  approval state with optional project scoping.
- Governed `move_task` write tool for board reprioritisation between columns,
  with optional project scoping in the POST body.
- A `.env.example` template documenting the server's environment variables.

### Changed

- Hardened HTTP serving with loopback-only binding, exact-host DNS-rebinding
  protection, and safe support for explicitly configured tunnel hosts.
- Adopted `develop` as the board integration branch and `main` as the protected
  release branch; CI now covers pull requests and pushes for both branches.
- Documented the branch model, tool-contract versioning policy, live integration
  procedure, governance boundaries, and release responsibilities.
- Added repository prose and deployment-name hygiene checks plus ignores for
  runtime worktrees and generated worktree state.
- Renamed the npm package to `@tchori-labs/fusion-mcp` and made it publishable.
- Removed `private` and added `publishConfig`, a `files` allowlist limiting the
  published tarball to `dist`, `README.md`, `LICENSE`, and `tool-contract.json`,
  plus `repository`, `bugs`, `homepage`, `keywords`, and `license` metadata.
- Rewrote the README for external consumers with installation and MCP client
  configuration instructions, and dropped org-internal references from the
  README and the agent contract's project layout.
- Excluded test-only setup files from the build so they are not published.

### Fixed

- Normalized governed tool failures into a stable, compatibility-sensitive error
  contract with fixed safe messages and redacted validation context.
- Hardened successful-response decoding so empty or malformed upstream payloads,
  response-body timeouts, and transport failures cannot appear as successful
  tool results or leak upstream details.
- Enforced hermetic mandatory tests with a fail-fast network guard across TCP,
  TLS, UDP, HTTP(S), and DNS paths.
- Corrected the specification's governed-tool regression-test description and
  the README's audit-metadata description to match the implemented behavior.
