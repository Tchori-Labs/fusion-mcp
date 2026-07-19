import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

function repositoryFile(path: string): string {
  return readFileSync(`${REPOSITORY_ROOT}/${path}`, "utf8");
}

describe("release documentation hygiene", () => {
  it("keeps the changelog aligned with the package version", () => {
    const changelogPath = `${REPOSITORY_ROOT}/CHANGELOG.md`;
    expect(existsSync(changelogPath)).toBe(true);

    const changelog = repositoryFile("CHANGELOG.md");
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      version?: unknown;
    };

    expect(changelog.startsWith("# Changelog\n")).toBe(true);
    expect(changelog).toMatch(/^## \[Unreleased\]$/mu);
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/u);

    const releaseVersions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\](?: - \d{4}-\d{2}-\d{2})?$/gmu)]
      .map((match) => match[1]);
    expect(releaseVersions).toContain(packageJson.version);
  });

  it("pins the 0.1.0 changelog to the complete shipped catalogue", () => {
    const changelog = repositoryFile("CHANGELOG.md");
    const releaseHeading = /^## \[0\.1\.0\](?: - \d{4}-\d{2}-\d{2})?$/mu.exec(
      changelog,
    );

    expect(releaseHeading).not.toBeNull();
    const sectionStart =
      (releaseHeading?.index ?? 0) + (releaseHeading?.[0].length ?? 0);
    const remainingChangelog = changelog.slice(sectionStart);
    const nextHeading = /^## /mu.exec(remainingChangelog);
    const releaseSection = remainingChangelog.slice(
      0,
      nextHeading?.index ?? remainingChangelog.length,
    );
    const shippedTools = [
      "get_board_health",
      "list_tasks",
      "get_task",
      "get_task_logs",
      "get_task_workflow_results",
      "list_projects",
      "read_project_settings",
      "create_task",
      "comment_task",
      "steer_task",
      "pause_task",
      "unpause_task",
      "list_approvals",
      "get_approval",
      "list_missions",
      "get_mission",
      "move_task",
    ];

    for (const tool of shippedTools) {
      expect(releaseSection, `missing shipped tool: ${tool}`).toContain(tool);
    }
    const packageName = ["@tcho", "ri-labs/fusion-mcp"].join("");
    expect(releaseSection).toContain(packageName);
  });

  it("documents every required release command", () => {
    const runbookPath = `${REPOSITORY_ROOT}/docs/release.md`;
    expect(existsSync(runbookPath)).toBe(true);

    const runbook = repositoryFile("docs/release.md");
    const requiredCommands = [
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
      "pnpm contract:check",
      "pnpm contract:generate",
    ];

    for (const command of requiredCommands) {
      expect(runbook, `missing release command: ${command}`).toContain(command);
    }
  });
});
