# Release procedure

This runbook prepares a release from the integration branch into the protected
release branch. It does not authorize an agent to merge a pull request, create a
tag, or publish a release. Those actions remain human-controlled.

## Who does what

| Stage | Authorized actor | Responsibility |
| --- | --- | --- |
| Prepare | Agent or human release preparer | Verify gates, version, contract baseline, and changelog; open the same-repository release pull request when its recorded scope and other preconditions are satisfied. |
| Review and merge | Human | Review the pull request and merge it with a merge commit. Do not squash. |
| Tag and publish | Human, or an explicitly authorized follow-up | Tag the merge commit and publish the release using the changelog entry. |
| Reconcile branches | Human release owner | Back-merge the release branch into the integration branch when the release merge created a delta, then decide and record the development-version convention. |

Agents never approve or merge pull requests, create release tags, or publish
releases. Opening a release pull request does not cross that boundary; it only
prepares the change for human review.

## 1. Verify the integration branch

Fetch the remote, check out the latest `develop`, and confirm that the required
CI run for that exact commit is green. From a clean local checkout, install the
locked dependencies and run all five release gates:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm contract:check
```

Treat every failure as blocking. The required **Build & Test** CI job runs lint,
typecheck, test, and build for pull requests and pushes to both `develop` and
`main`. Its `pnpm test` step executes `src/tool-contract.test.ts`, so the
contract check is enforced in CI even though `pnpm contract:check` is not a
separate workflow step. Run the named contract command locally as an explicit
release check.

## 2. Verify the version

Read the `version` field in `package.json` and confirm that the intended tag is
exactly `v<version>`. Versions follow Semantic Versioning. While the package is
in the `0.x` series, bump the minor version for a breaking public-contract
change and the patch version for a compatible fix. Additive governed tools may
ship in the current minor version when the tool-contract policy permits them.

Confirm that the server's advertised version remains aligned with the package
version before opening the release pull request.

## 3. Pin the tool contract

Regenerate the MCP contract baseline, then prove that generation did not change
the committed manifest:

```bash
pnpm contract:generate
git diff --exit-code -- tool-contract.json
pnpm contract:check
```

A diff means the candidate is not ready: review the generated change and commit
it with the implementation that caused the compatible contract addition. Never
edit `tool-contract.json` by hand or remove historical baselines. Baselines are
append-only within a package major. Follow the compatibility and breaking-change
process in [MCP tool contract versioning](./tool-contract-versioning.md).

## 4. Finalize the changelog

Use [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) structure. Move the
release's entries from `## [Unreleased]` into a dated
`## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md`, while retaining an empty
`Unreleased` section for the next cycle. Confirm that the entry describes the
actual shipped tool catalogue, transports, compatibility behavior, and notable
documentation or operational changes.

## 5. Open the release pull request

Before opening anything, verify and record:

1. prerequisite board tasks are complete;
2. a human has chosen the release scope and the decision is recorded; and
3. no unrelated pull request remains open against `main`.

Open one pull request with base `main`, head `develop`, and title
`release: vX.Y.Z`. The repository's **Release guard** admits only `develop`,
`release/*`, or `hotfix/*` heads into `main`. The release body must include:

- the recorded human scope decision, including a link or quotation showing
  where it was recorded;
- the complete shipped-tools list;
- notable changes; and
- the version's changelog entry.

Do not open the pull request if any precondition is missing, and do not infer a
scope from the current branch contents. Record the blocker for a human instead.
The pull request must stay open for human review; do not approve it, enable
auto-merge, or merge it.

## 6. Human merge

After all required checks and human review pass, a human merges the release pull
request with a **merge commit**, not a squash merge. The merge commit preserves
the task history already integrated on `develop`. Agents do not perform or
approve this action.

## 7. Human tag and publication

A human, or an explicitly authorized follow-up, checks out the resulting `main`
merge commit, creates the annotated tag `vX.Y.Z` on that exact commit, and
pushes the tag. The same authorized actor publishes the corresponding GitHub
Release with the `X.Y.Z` changelog entry as its body.

Verify the tag target before publication. Agents do not create or push tags and
do not draft or publish releases unless a later, explicit authorization assigns
that human-controlled follow-up.

## 8. Post-release reconciliation

Compare `main` and `develop` after publication. If the merge commit or release
preparation created any delta that is not already on `develop`, a human release
owner back-merges `main` into `develop` so the branches do not drift.

The project has **not yet adopted** a next-version `-dev` bump convention.
During the first post-release reconciliation, the team must decide whether
`develop` should immediately move to the next `-dev` version and record that
choice in this runbook. Until that decision is recorded, do not invent or apply
a development-version suffix automatically.
