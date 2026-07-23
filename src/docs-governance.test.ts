import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const agents = readFileSync(`${REPOSITORY_ROOT}/AGENTS.md`, "utf8");
const spec = readFileSync(`${REPOSITORY_ROOT}/SPEC.md`, "utf8");

describe("governance documentation", () => {
  it("keeps AGENTS.md aligned with the canonical governed write surface", () => {
    const governanceSection = agents.match(
      /## What this project is\s+([\s\S]*?)\n## /u,
    );

    expect(governanceSection).not.toBeNull();
    const governance = governanceSection?.[1] ?? "";

    expect(agents).not.toMatch(/change settings, delete\/archive tasks/u);
    expect(governance).toMatch(
      /SPEC\.md[\s\S]*Governance invariants[^.]*canonical/iu,
    );
    expect(governance).toMatch(/exactly two narrow exceptions/iu);
    expect(governance).toMatch(
      /update_project_settings[\s\S]*hard-allowlisted keys[\s\S]*invariant 2/iu,
    );
    expect(governance).toMatch(
      /archive_task[\s\S]*recoverable board hygiene[\s\S]*invariant 3/iu,
    );
    expect(governance).toMatch(/merge PRs/iu);
    expect(governance).toMatch(/approve plans/iu);
    expect(governance).toMatch(/delete tasks/iu);
    expect(governance).toMatch(/irreversible or bulk destructive operation/iu);
    expect(governance).toMatch(/restart or control the system/iu);
    expect(governance).toMatch(/publish anything outside the board/iu);
    expect(governance).toMatch(/No broader capability is authorized/iu);

    expect(spec).toContain("update_project_settings");
    expect(spec).toContain("archive_task");
  });
});
