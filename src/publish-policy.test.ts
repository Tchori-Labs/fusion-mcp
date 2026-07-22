import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLISH_WORKFLOW_PATH = ".github/workflows/publish.yml";

function publishWorkflow(): string {
  const path = `${REPOSITORY_ROOT}/${PUBLISH_WORKFLOW_PATH}`;
  expect(existsSync(path), `${PUBLISH_WORKFLOW_PATH} must exist`).toBe(true);
  return readFileSync(path, "utf8");
}

describe("publish workflow policy", () => {
  it("runs only for version-tag pushes or manual dispatch", () => {
    const workflow = publishWorkflow();

    expect(workflow, "publish must declare the push trigger").toMatch(
      /^\s+push:\s*$/mu,
    );
    expect(workflow, "publish must restrict pushes to version tags").toMatch(
      /^\s+tags:\s*\n\s+- ["']v\*["']\s*$/mu,
    );
    expect(workflow, "publish must retain workflow_dispatch").toMatch(
      /^\s+workflow_dispatch:\s*$/mu,
    );

    const forbiddenTriggers = [
      "pull_request",
      "pull_request_target",
      "schedule",
      "workflow_call",
      "workflow_run",
    ];
    for (const trigger of forbiddenTriggers) {
      expect(
        workflow,
        `publish must not declare the ${trigger} trigger`,
      ).not.toMatch(new RegExp(`^\\s*${trigger}:`, "mu"));
    }
  });

  it("holds exactly the read + OIDC permissions and nothing more", () => {
    const workflow = publishWorkflow();

    expect(workflow, "publish must declare contents: read").toMatch(
      /^\s+contents: read$/mu,
    );
    expect(
      workflow,
      "publish must declare id-token: write for Trusted Publishing",
    ).toMatch(/^\s+id-token: write\b/mu);

    const writeGrants = workflow
      .split("\n")
      .filter((line) => /^\s+[a-z-]+: write\b/u.test(line))
      .map((line) => line.trim().replace(/\s*#.*$/u, ""));
    expect(
      writeGrants,
      "id-token must be the only write permission granted",
    ).toEqual(["id-token: write"]);
  });

  it("publishes only through the protected npm-publish environment", () => {
    expect(
      publishWorkflow(),
      "publish job must bind the npm-publish environment",
    ).toMatch(/^\s+environment: npm-publish$/mu);
  });

  it("resolves manual and push tags without shell interpolation", () => {
    const workflow = publishWorkflow();
    const inputReferences = workflow
      .split("\n")
      .filter((line) => line.includes("inputs.tag"));

    expect(
      inputReferences.length,
      "the manual tag input must be referenced somewhere",
    ).toBeGreaterThan(0);
    for (const line of inputReferences) {
      expect(
        line,
        "the tag selector may only feed env indirection, checkout refs, or concurrency",
      ).toMatch(/^\s*(TAG:|ref:|group:)/u);
      expect(line, "push runs must fall back to github.ref_name").toContain(
        "inputs.tag || github.ref_name",
      );
    }
    expect(workflow).not.toMatch(/^\s*run:\s*.*\$\{\{[^\n]*inputs\.tag/mu);
  });

  it("checks out only the fully qualified tag and verifies its commit", () => {
    const workflow = publishWorkflow();
    const qualifiedTagRefs =
      workflow.match(
        /^\s+ref:\s*\$\{\{\s*format\('refs\/tags\/\{0\}',\s*inputs\.tag \|\| github\.ref_name\)\s*\}\}\s*$/gmu,
      ) ?? [];

    expect(
      qualifiedTagRefs,
      "both pack-smoke and publish checkouts must use a fully qualified tag ref",
    ).toHaveLength(2);
    expect(workflow).toContain(
      'TAG_SHA="$(git rev-parse "refs/tags/${TAG}^{commit}")"',
    );
    expect(workflow).toContain('HEAD_SHA="$(git rev-parse HEAD)"');
    expect(workflow).toContain('if [ "$HEAD_SHA" != "$TAG_SHA" ]; then');
  });

  it("does not restore dependency caches into the release build", () => {
    expect(
      publishWorkflow(),
      "release builds that mint provenance must not use dependency caching",
    ).not.toMatch(/^\s+cache:/mu);
  });

  it("pins every external action to a full commit SHA", () => {
    const uses = publishWorkflow()
      .split("\n")
      .filter((line) => /^\s+uses:/u.test(line));
    const localReusableWorkflow =
      /^uses: \.\/\.github\/workflows\/[^\s]+\.yml$/u;

    expect(uses.length, "publish must use at least one action").toBeGreaterThan(
      0,
    );
    for (const line of uses) {
      if (localReusableWorkflow.test(line.trim())) {
        continue;
      }
      expect(
        line,
        "external actions in publish must be pinned to a 40-hex commit SHA",
      ).toMatch(/uses:\s+\S+@[0-9a-f]{40}(\s+#.*)?$/u);
    }
  });

  it("requires both packed-artifact and live-integration release gates", () => {
    const workflow = publishWorkflow();

    expect(workflow).toMatch(
      /^  live-integration:\s*$[\s\S]*?^    uses:\s*\.\/\.github\/workflows\/live-integration\.yml\s*$[\s\S]*?^    secrets:\s*inherit\s*$/mu,
    );
    expect(workflow).toMatch(
      /^  publish:\s*$[\s\S]*?^    needs:\s*\[pack-smoke, live-integration\]\s*$/mu,
    );
  });
});
