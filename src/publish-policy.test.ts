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
  it("is isolated to manual workflow_dispatch runs", () => {
    const workflow = publishWorkflow();

    expect(
      workflow,
      "publish must declare workflow_dispatch",
    ).toMatch(/^on:\s*\n\s+workflow_dispatch:\s*$/mu);

    const forbiddenTriggers = [
      "push",
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

    expect(
      workflow,
      "publish must declare contents: read",
    ).toMatch(/^\s+contents: read$/mu);
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

  it("never interpolates the tag input into shell scripts", () => {
    const workflow = publishWorkflow();
    const interpolations = workflow
      .split("\n")
      .filter((line) => line.includes("${{ inputs.tag }}"));

    expect(
      interpolations.length,
      "the tag input must be referenced somewhere",
    ).toBeGreaterThan(0);
    for (const line of interpolations) {
      expect(
        line,
        "inputs.tag may only feed env indirection, the checkout ref, or the concurrency group",
      ).toMatch(/^\s*(TAG:|ref:|group:)/u);
    }
  });

  it("does not restore dependency caches into the release build", () => {
    expect(
      publishWorkflow(),
      "release builds that mint provenance must not use dependency caching",
    ).not.toMatch(/^\s+cache:/mu);
  });

  it("pins every action to a full commit SHA", () => {
    const uses = publishWorkflow()
      .split("\n")
      .filter((line) => /^\s+uses:/u.test(line));

    expect(uses.length, "publish must use at least one action").toBeGreaterThan(0);
    for (const line of uses) {
      expect(
        line,
        "actions in the publish workflow must be pinned to a 40-hex commit SHA",
      ).toMatch(/uses:\s+\S+@[0-9a-f]{40}(\s+#.*)?$/u);
    }
  });
});
