#!/usr/bin/env bash
#
# release.sh — drive a fusion-mcp release end to end.
#
# Encodes the exact flow used to ship v0.1.3 (the runbook prose lives in
# docs/release.md — this script is the executable companion, not a replacement).
#
# Flow, given a target VERSION (e.g. 0.1.3):
#   1. Prep branch off develop: bump package.json + src/index.ts + CHANGELOG,
#      regenerate the tool contract, run every release gate.
#   2. Open the prep PR into develop; merge it once CI is green.
#   3. Open the develop -> main release PR; merge it with a MERGE COMMIT
#      (never squash — the merge commit is what gets tagged).
#   4. Annotated tag vVERSION on the merge commit; push it.
#   5. Dispatch publish.yml ON THE TAG REF (--ref vVERSION). This is the step
#      that bit us: the npm-publish environment only admits `v*` tag refs, so a
#      default-branch dispatch (develop) is rejected in ~1s with zero steps.
#   6. A human approves the npm-publish environment gate in the GitHub UI; the
#      workflow then publishes to npm with OIDC provenance.
#
# Human gates: the develop->main merge, the tag, the publish dispatch, and the
# npm-publish approval are deliberate actions. This script pauses for a typed
# confirmation before each; it never auto-approves the environment gate.
#
# Usage:
#   scripts/release.sh <version>            # e.g. scripts/release.sh 0.1.4
#   scripts/release.sh <version> --resume   # skip prep; land + tag + publish an
#                                           # already-prepared develop
#
# Requirements: gh (authenticated), pnpm, node >=22, jq, a clean working tree.

set -euo pipefail

REPO="Tchori-Labs/fusion-mcp"

# --- arg parsing -------------------------------------------------------------

VERSION="${1:-}"
MODE="${2:-full}"
if [[ -z "$VERSION" ]]; then
  echo "usage: scripts/release.sh <version> [--resume]" >&2
  exit 2
fi
VERSION="${VERSION#v}"                 # tolerate a leading v
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be X.Y.Z (got '$VERSION')" >&2
  exit 2
fi
TAG="v$VERSION"
PREP_BRANCH="chore/release-${TAG}-prep"

# --- helpers -----------------------------------------------------------------

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mERR %s\033[0m\n' "$*" >&2; exit 1; }

confirm() {
  # confirm "<prompt>" — require the operator to type 'yes'.
  local reply
  read -r -p "$(printf '\033[1;35m??  %s [type yes] \033[0m' "$1")" reply
  [[ "$reply" == "yes" ]] || die "aborted by operator"
}

require() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }

gates() {
  say "Running release gates (lint, typecheck, test, build, contract:check)"
  pnpm install --frozen-lockfile
  pnpm lint
  pnpm typecheck
  pnpm test
  pnpm build
  pnpm contract:check
}

pin_contract() {
  say "Regenerating and verifying the tool-contract baseline"
  pnpm contract:generate
  git diff --exit-code -- tool-contract.json \
    || die "tool-contract.json changed on regenerate — commit the contract with the change that caused it, then re-run"
}

# Wait for the required Build & Test check on a PR to succeed.
wait_for_ci() {
  local pr="$1"
  say "Waiting for CI on PR #$pr"
  gh pr checks "$pr" --repo "$REPO" --watch --required \
    || die "required checks did not pass on PR #$pr"
}

# --- preflight ---------------------------------------------------------------

require gh; require pnpm; require jq; require node
gh auth status >/dev/null 2>&1 || die "gh is not authenticated"
[[ -f package.json ]] || die "run from the repo root"
[[ -z "$(git status --porcelain)" ]] || die "working tree is not clean"

say "Releasing $TAG (mode: $MODE)"

# =============================================================================
# Stage 1 — prepare (skipped with --resume)
# =============================================================================

if [[ "$MODE" != "--resume" ]]; then
  say "Preparing $PREP_BRANCH off origin/develop"
  git fetch origin --quiet
  git switch -c "$PREP_BRANCH" origin/develop

  say "Bumping version to $VERSION in package.json and src/index.ts"
  # package.json "version" field
  node -e '
    const fs=require("fs"); const v=process.argv[1];
    const p=JSON.parse(fs.readFileSync("package.json","utf8"));
    p.version=v; fs.writeFileSync("package.json", JSON.stringify(p,null,2)+"\n");
  ' "$VERSION"
  # src/index.ts McpServer version literal
  if ! grep -q "version: \"$VERSION\"" src/index.ts; then
    perl -0pi -e "s/(new McpServer\(\{[^}]*version:\s*\")[0-9]+\.[0-9]+\.[0-9]+(\")/\${1}$VERSION\${2}/s" src/index.ts
  fi
  grep -q "version: \"$VERSION\"" src/index.ts \
    || warn "could not confirm src/index.ts version literal — check it by hand"

  warn "Update CHANGELOG.md now: move the [Unreleased] entries into"
  warn "'## [$VERSION] - <today>' (keep an empty Unreleased section), then save."
  confirm "CHANGELOG.md updated for $VERSION?"

  pin_contract
  gates

  say "Committing and pushing the prep branch"
  git add -A
  git commit -m "chore(release): prepare $TAG"
  git push -u origin "$PREP_BRANCH"

  say "Opening prep PR into develop"
  gh pr create --repo "$REPO" --base develop --head "$PREP_BRANCH" \
    --title "chore(release): prepare $TAG" \
    --body "Version bump + CHANGELOG for $TAG. Lands on develop ahead of the develop -> main release PR."
  PREP_PR="$(gh pr view "$PREP_BRANCH" --repo "$REPO" --json number -q .number)"
  wait_for_ci "$PREP_PR"

  confirm "Merge prep PR #$PREP_PR into develop (squash)?"
  gh pr merge "$PREP_PR" --repo "$REPO" --squash
fi

# =============================================================================
# Stage 2 — land develop -> main
# =============================================================================

say "Opening the develop -> main release PR"
git fetch origin --quiet
# Reuse an existing open release PR if one is already there.
REL_PR="$(gh pr list --repo "$REPO" --base main --head develop --state open --json number -q '.[0].number // empty')"
if [[ -z "$REL_PR" ]]; then
  gh pr create --repo "$REPO" --base main --head develop \
    --title "release: $TAG" \
    --body "Release $TAG. Merge with a MERGE COMMIT (not squash); the merge commit is tagged $TAG and published via publish.yml (npm-publish env gate)."
  REL_PR="$(gh pr list --repo "$REPO" --base main --head develop --state open --json number -q '.[0].number')"
fi
say "Release PR is #$REL_PR"
wait_for_ci "$REL_PR"

MERGEABLE="$(gh pr view "$REL_PR" --repo "$REPO" --json mergeable -q .mergeable)"
[[ "$MERGEABLE" == "MERGEABLE" ]] || die "PR #$REL_PR is not mergeable ($MERGEABLE)"

confirm "Merge release PR #$REL_PR into main with a MERGE COMMIT?"
gh pr merge "$REL_PR" --repo "$REPO" --merge

# =============================================================================
# Stage 3 — tag the merge commit
# =============================================================================

say "Fetching the main merge commit to tag"
git fetch origin main --quiet
MERGE_SHA="$(git rev-parse origin/main)"
say "main is at $MERGE_SHA"
git --no-pager log --oneline -1 "$MERGE_SHA"

# Sanity: the tagged commit's package.json must equal $VERSION.
PKG_AT_MERGE="$(git show "$MERGE_SHA:package.json" | jq -r .version)"
[[ "$PKG_AT_MERGE" == "$VERSION" ]] \
  || die "package.json at merge commit is $PKG_AT_MERGE, expected $VERSION"

confirm "Create annotated tag $TAG on $MERGE_SHA and push it?"
git tag -a "$TAG" "$MERGE_SHA" -m "$TAG"
git push origin "$TAG"

# =============================================================================
# Stage 4 — publish via CI (dispatch on the TAG ref)
# =============================================================================

confirm "Dispatch publish.yml for $TAG?"
# CRITICAL: dispatch ON THE TAG REF. The npm-publish environment admits only
# `v*` tag refs; dispatching on the default branch (develop) is rejected in ~1s.
gh workflow run publish.yml --repo "$REPO" --ref "$TAG" -f "tag=$TAG"
sleep 8
RUN_ID="$(gh run list --repo "$REPO" --workflow=publish.yml --limit 1 --json databaseId -q '.[0].databaseId')"
RUN_URL="https://github.com/$REPO/actions/runs/$RUN_ID"
say "Publish run: $RUN_URL"

say "Waiting for the npm-publish environment gate"
for _ in $(seq 1 30); do
  PENDING="$(gh api "repos/$REPO/actions/runs/$RUN_ID/pending_deployments" \
    -q '.[] | select(.environment.name=="npm-publish") | .environment.name' 2>/dev/null || true)"
  [[ -n "$PENDING" ]] && break
  sleep 2
done
if [[ -n "${PENDING:-}" ]]; then
  warn "ACTION REQUIRED: approve the 'npm-publish' deployment in the GitHub UI:"
  warn "  $RUN_URL  ->  Review deployments -> npm-publish -> Approve and deploy"
else
  warn "No pending gate detected yet — check the run: $RUN_URL"
fi

say "Watching the publish run to completion (approve the gate to let it proceed)"
gh run watch "$RUN_ID" --repo "$REPO" --exit-status || die "publish run failed: $RUN_URL"

# =============================================================================
# Stage 5 — verify + reconcile reminder
# =============================================================================

say "Verifying the npm registry"
LATEST="$(curl -fsSL "https://registry.npmjs.org/@tchori-labs/fusion-mcp" | jq -r '."dist-tags".latest')"
if [[ "$LATEST" == "$VERSION" ]]; then
  say "Published: @tchori-labs/fusion-mcp@$VERSION is now 'latest' 🎉"
else
  warn "Registry 'latest' is $LATEST (CDN caches can lag a few minutes for the public view;"
  warn "the run succeeded and the direct registry read above is authoritative)."
fi

warn "Post-release: the develop -> main merge commit is not on develop."
warn "Per docs/release.md §9, decide whether to back-merge main into develop"
warn "so the branches do not drift."
