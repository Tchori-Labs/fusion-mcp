import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIVE_WORKFLOW_PATH = ".github/workflows/live-integration.yml";
const STABILITY_WORKFLOW_PATH = ".github/workflows/stability.yml";

function repositoryFile(path: string): string {
  return readFileSync(`${REPOSITORY_ROOT}/${path}`, "utf8");
}

function liveWorkflow(): string {
  const path = `${REPOSITORY_ROOT}/${LIVE_WORKFLOW_PATH}`;
  expect(existsSync(path), `${LIVE_WORKFLOW_PATH} must exist`).toBe(true);
  return repositoryFile(LIVE_WORKFLOW_PATH);
}

function stabilityWorkflow(): string {
  const path = `${REPOSITORY_ROOT}/${STABILITY_WORKFLOW_PATH}`;
  expect(existsSync(path), `${STABILITY_WORKFLOW_PATH} must exist`).toBe(true);
  return repositoryFile(STABILITY_WORKFLOW_PATH);
}

describe("stability workflow policy", () => {
  it("runs only on manual dispatch and the daily schedule", () => {
    const workflow = stabilityWorkflow();

    expect(workflow, "stability must declare workflow_dispatch").toMatch(
      /^\s+workflow_dispatch:\s*$/mu,
    );
    expect(workflow, "stability must declare schedule").toMatch(
      /^\s+schedule:\s*$/mu,
    );
    expect(workflow.match(/^\s+- cron:\s*.*$/gmu)).toHaveLength(1);

    const forbiddenTriggers = [
      "push",
      "pull_request",
      "pull_request_target",
      "workflow_call",
      "workflow_run",
    ];
    for (const trigger of forbiddenTriggers) {
      expect(
        workflow,
        `stability must not declare the ${trigger} trigger`,
      ).not.toMatch(new RegExp(`^\\s*${trigger}:`, "mu"));
    }
  });

  it("stays separate from and does not slow the required check", () => {
    const workflow = stabilityWorkflow();
    const requiredWorkflow = repositoryFile(".github/workflows/ci.yml");

    expect(
      workflow,
      "stability must not use the required Build & Test job name",
    ).not.toMatch(/^\s+name:\s*Build & Test\s*$/mu);
    expect(
      workflow,
      "stability must not use the required build-and-test job id",
    ).not.toMatch(/^\s{2}build-and-test:\s*$/mu);
    expect(
      requiredWorkflow,
      "required CI must retain the Build & Test job name",
    ).toMatch(/^\s+name:\s*Build & Test\s*$/mu);
    expect(requiredWorkflow).not.toContain("test:stability");
    expect(requiredWorkflow).not.toContain("test:live");
  });

  it("remains credential-free and excludes live tests", () => {
    const workflow = stabilityWorkflow();

    for (const forbiddenValue of [
      "secrets.",
      "vars.",
      "FUSION_TOKEN",
      "FUSION_BASE_URL",
      "FUSION_MCP_LIVE",
      "test:live",
    ]) {
      expect(
        workflow,
        `stability must not contain ${forbiddenValue}`,
      ).not.toContain(forbiddenValue);
    }
  });

  it("installs before running the stability command", () => {
    const workflow = stabilityWorkflow();
    const installIndex = workflow.indexOf("pnpm install --frozen-lockfile");
    const stabilityIndex = workflow.indexOf("pnpm test:stability");

    expect(installIndex).toBeGreaterThan(-1);
    expect(stabilityIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeLessThan(stabilityIndex);
  });

  it("preserves the default count and uploads restricted failure results", () => {
    const workflow = stabilityWorkflow();

    expect(workflow).not.toContain("FUSION_MCP_STABILITY_ITERATIONS");
    expect(workflow).toMatch(/^\s+if:\s*failure\(\)\s*$/mu);
    expect(workflow).toContain("actions/upload-artifact@v4");
    const artifactPaths = workflow.match(/^\s+path:\s*.*$/gmu) ?? [];
    expect(artifactPaths).toEqual(["          path: stability-results/*.json"]);
  });
});

describe("live integration workflow policy", () => {
  it("is isolated to manual workflow_dispatch runs", () => {
    const workflow = liveWorkflow();

    expect(workflow, "live integration must declare workflow_dispatch").toMatch(
      /^on:\s*\n\s+workflow_dispatch:\s*$/mu,
    );

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
        `live integration must not declare the ${trigger} trigger`,
      ).not.toMatch(new RegExp(`^\\s*${trigger}:`, "mu"));
    }
  });

  it("stays separate from the required Build & Test check", () => {
    const workflow = liveWorkflow();
    const requiredWorkflow = repositoryFile(".github/workflows/ci.yml");

    expect(
      workflow,
      "live integration must not use the required Build & Test job name",
    ).not.toMatch(/^\s+name:\s*Build & Test\s*$/mu);
    expect(
      workflow,
      "live integration must not use the required build-and-test job id",
    ).not.toMatch(/^\s{2}build-and-test:\s*$/mu);
    expect(
      requiredWorkflow,
      "required CI must retain the Build & Test job name",
    ).toMatch(/^\s+name:\s*Build & Test\s*$/mu);
    expect(
      requiredWorkflow,
      "required CI must never run the opt-in live suite",
    ).not.toContain("test:live");
  });

  it("wires protected configuration without secret-printing commands", () => {
    const workflow = liveWorkflow();

    expect(
      workflow,
      "live integration must explicitly opt in with FUSION_MCP_LIVE=1",
    ).toMatch(/^\s+FUSION_MCP_LIVE:\s*"1"\s*$/mu);
    const baseUrlMappings =
      workflow.match(/^\s+FUSION_BASE_URL:\s*.*$/gmu) ?? [];
    const tokenMappings = workflow.match(/^\s+FUSION_TOKEN:\s*.*$/gmu) ?? [];
    expect(
      baseUrlMappings,
      "FUSION_BASE_URL must have exactly one job environment mapping",
    ).toHaveLength(1);
    expect(
      baseUrlMappings[0],
      "FUSION_BASE_URL must come from a GitHub environment variable",
    ).toMatch(
      /^\s+FUSION_BASE_URL:\s*\$\{\{\s*vars\.FUSION_BASE_URL\s*\}\}\s*$/u,
    );
    expect(
      tokenMappings,
      "FUSION_TOKEN must have exactly one job environment mapping",
    ).toHaveLength(1);
    expect(
      tokenMappings[0],
      "FUSION_TOKEN must come from a GitHub environment secret",
    ).toMatch(/^\s+FUSION_TOKEN:\s*\$\{\{\s*secrets\.FUSION_TOKEN\s*\}\}\s*$/u);
    expect(
      workflow,
      "live integration must not hardcode an HTTP base URL",
    ).not.toMatch(/https?:\/\//u);
    expect(
      workflow,
      "live integration must use a protected GitHub environment",
    ).toMatch(/^\s+environment:\s*live-integration\s*$/mu);
    expect(
      workflow,
      "live integration must have a bounded job timeout",
    ).toMatch(/^\s+timeout-minutes:\s*\d+\s*$/mu);
    expect(workflow, "shell tracing could expose live credentials").not.toMatch(
      /\bset\s+-x\b/u,
    );
    expect(workflow, "printenv could expose live credentials").not.toMatch(
      /\bprintenv\b/u,
    );
    expect(
      workflow,
      "a bare env command could expose live credentials",
    ).not.toMatch(/^\s*(?:run:\s*)?(?:env|printenv)\s*$/mu);
    expect(workflow, "the live token must never be echoed").not.toMatch(
      /\becho\b[^\n]*(?:\$FUSION_TOKEN|\$\{FUSION_TOKEN\}|\$\{\{\s*secrets\.FUSION_TOKEN\s*\}\})/u,
    );
  });

  it("preserves default journeys and builds before running them", () => {
    const workflow = liveWorkflow();
    const buildIndex = workflow.indexOf("pnpm build");
    const liveTestIndex = workflow.indexOf("pnpm test:live");

    expect(
      workflow,
      "CI must preserve the default 10 live journey iterations",
    ).not.toContain("FUSION_MCP_LIVE_ITERATIONS");
    expect(buildIndex, "live integration must run pnpm build").toBeGreaterThan(
      -1,
    );
    expect(
      liveTestIndex,
      "live integration must run pnpm test:live",
    ).toBeGreaterThan(-1);
    expect(
      buildIndex,
      "pnpm build must run before pnpm test:live",
    ).toBeLessThan(liveTestIndex);
  });

  it("uploads only redacted failure traces when artifacts are enabled", () => {
    const workflow = liveWorkflow();

    if (workflow.includes("upload-artifact")) {
      expect(
        workflow,
        "live diagnostics must upload only when the job fails",
      ).toMatch(/^\s+if:\s*failure\(\)\s*$/mu);
      const artifactPaths = workflow.match(/^\s+path:\s*.*$/gmu) ?? [];
      expect(
        artifactPaths,
        "live diagnostics must declare a redacted harness trace path",
      ).not.toHaveLength(0);
      for (const artifactPath of artifactPaths) {
        expect(
          artifactPath,
          "every live diagnostic path must be restricted to redacted harness traces",
        ).toMatch(/^\s+path:\s*\/tmp\/fusion-mcp-\*\.log\s*$/u);
      }
      expect(
        workflow,
        "live diagnostics must never upload the whole workspace",
      ).not.toMatch(/^\s+path:\s*\.(?:\/)?\s*$/mu);
    }
  });
});
