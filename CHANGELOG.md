# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Corrected project-scope placement and trusted-publishing command documentation.

## [0.2.0] - 2026-07-22

### Added

- Governed `update_project_settings` writes for eight hard-allowlisted project
  keys plus strengthen-only `planApprovalMode: "require-all"`, with credential
  redaction applied to upstream response payloads.
- Governed `update_task` writes limited to dependencies, priority, title, and
  description, plus recoverable board-hygiene archiving through `archive_task`.
- `read_project_settings` now masks `daemonToken` and every nested key matching
  `/token|secret|passphrase|credential/i` as `[REDACTED]` before returning the
  settings payload (issue #87).
- A generated additive tool-contract baseline for the three new tools.
- A packed-artifact smoke gate now blocks tagged publication until the tarball
  clean-installs and its installed bin completes an MCP initialize handshake.
- The required live release gate now verifies explicit and default project scope
  across multiple projects before publication.

### Changed

- Governance invariants now record the approved project-settings, task-metadata,
  and recoverable archive surfaces while continuing to exclude global settings,
  provider/model configuration, credential keys, delete, merge, approve, and
  publish operations.

## [0.1.3] - 2026-07-19

### Fixed

- Task-scoped log, workflow-result, communication, pause, and unpause tools now
  apply explicit or configured default project scope on multi-project boards
  (issue #80).

## [0.1.2] - 2026-07-19

### Added

- Environment-only Access service-token headers and an optional upstream
  `User-Agent` override for boards behind an authenticating edge.

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
- Read-only `list_missions` and `get_mission` tools for inspecting the board
  mission hierarchy with optional project scoping.
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
