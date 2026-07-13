# FM-004 — Deploy docs + client hardening

## Context

`fusion-mcp` is a governed MCP server wrapping the Fusion agent-board REST API,
intended to run on the **same LXC as the Fusion daemon** and be exposed via a
Cloudflare Tunnel + Access. The scaffold ships `FusionClient` (fetch wrapper with
timeout + token-free `FusionError`), stdio + HTTP transports, and `auditLog`.
Read `SPEC.md` and `AGENTS.md` first; governance invariants and the
cross-repo/no-merge protocol are binding.

## Scope

### 1. `docs/deploy.md`

Concrete deployment guide (extends the SPEC's deployment sketch):

- A **systemd unit** running `node dist/index.js --http`, with
  `Restart=on-failure`, `EnvironmentFile=`, loopback bind, and least-privilege
  user.
- An **env file template** (`fusion-mcp.env.example`, `0600`, root-owned) with
  `FUSION_BASE_URL`, `FUSION_TOKEN`, `FUSION_DEFAULT_PROJECT_ID`, `PORT`.
- Token provisioning via **`fn daemon --token-only`**; never commit the token.
- Health check guidance (`GET /api/health` on Fusion; systemd supervision).
- The Cloudflare Tunnel + Access exposure pattern (loopback only, no host port
  opened). Keep it a runbook, not IaC.

### 2. Client hardening (`src/fusion-client.ts`)

- **Error-message hygiene:** audit every error path and confirm the token can
  never appear (headers, URL, body snippet). Add a test that asserts a token-free
  message even when the token is embedded in a (hypothetical) echoed body.
- **Timeouts/retry policy:** keep the per-request timeout. Add a **single retry on
  `502`/`503` for idempotent reads only** (GET). **No retry on writes**
  (POST/PUT/PATCH/DELETE) and none on other status codes or network errors by
  default. Make the retry observable in tests (mock two responses).
- Keep the client small — no retry libraries.

### 3. README polish

- Fill in any gaps once all tools exist: full tool list with one-line
  descriptions, a complete Claude Code config example, and a link to
  `docs/deploy.md`.

## Files to touch

- `docs/deploy.md` (new), `fusion-mcp.env.example` (new).
- `src/fusion-client.ts` — retry + hygiene.
- `src/fusion-client.test.ts` — retry + hygiene tests.
- `README.md` — polish.

## Tests required (no network — inject `fetch`)

- Retry: a `GET` that returns `503` then `200` succeeds after one retry; a `GET`
  returning `503` twice fails; a `POST` returning `503` fails with **no** retry;
  a `500`/`404` is not retried.
- Hygiene: error messages never contain the token across all paths.

## Out of scope

New tools (FM-001/002/003).

## Deliverable

PR against `Tchori-Labs/fusion-mcp` main, all five commands green. **Do not merge.**
