import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EXIT_CLASSIFIED,
  EXIT_CLEAR,
  EXIT_USAGE_OR_IO,
  EXPECTED_SYNTHESIZED_MESSAGE_COUNT,
  SYNTHESIZED_VALIDATOR_MESSAGES,
} from "./validation-cause.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROTOCOL_PATH = "docs/validator-rederivation-protocol.md";

function repositoryFile(path: string): string {
  return readFileSync(`${REPOSITORY_ROOT}/${path}`, "utf8");
}

describe("validator re-derivation repository policy", () => {
  it("keeps the protocol document and synthesized messages in sync", () => {
    expect(existsSync(`${REPOSITORY_ROOT}/${PROTOCOL_PATH}`)).toBe(true);
    const protocol = repositoryFile(PROTOCOL_PATH);

    expect(SYNTHESIZED_VALIDATOR_MESSAGES.length).toBe(
      EXPECTED_SYNTHESIZED_MESSAGE_COUNT,
    );
    for (const message of SYNTHESIZED_VALIDATOR_MESSAGES) {
      expect(protocol, `protocol must document ${message}`).toContain(message);
    }
  });

  it("requires classify-before-implement across three independent axes", () => {
    const protocol = repositoryFile(PROTOCOL_PATH);

    expect(protocol).toMatch(/^## Classify before implementing$/mu);
    expect(protocol).toContain("run `pnpm rederivation:check` before");
    expect(protocol).toContain("forbids blind");
    expect(protocol).toContain("**Production code:**");
    expect(protocol).toContain("**Tests:**");
    expect(protocol).toContain("**Documentation:**");
    expect(protocol).toContain("fn_task_document_write");
    expect(protocol).toContain("leading `NO-OP:`");
  });

  it("states the partial scope, repository boundary, and residual risk", () => {
    const protocol = repositoryFile(PROTOCOL_PATH);

    expect(protocol).toMatch(/^## Scope$/mu);
    expect(protocol).toContain("human-authorized partial mitigation");
    expect(protocol).toContain("escalated rather than fixed");
    expect(protocol).toMatch(/^## Residual risk$/mu);
    expect(protocol).toContain("This detector is advisory");
    expect(protocol).toContain(
      "does not prevent board-side feature derivation",
    );
    expect(protocol).toContain("cross-repository PR or issue");
    expect(protocol).toMatch(/must be escalated to a\s+human/u);
    expect(protocol).toContain("`.fusion`, which is gitignored");
  });

  it("pins the canonical incident occurrence model", () => {
    const protocol = repositoryFile(PROTOCOL_PATH);
    const runIds = [
      "VR-MS428ZM5-0003-FT5P",
      "VR-MS430NW3-000L-JROW",
      "VR-MS43MAAX-0016-V7D8",
      "VR-MS45R27U-0049-H0XM",
    ];

    for (const runId of runIds) expect(protocol).toContain(runId);
    expect(protocol).toContain(
      "4 unique validator runs across 6 cause\nblocks in 4 spawned tasks",
    );
    expect(protocol).toContain("re-deriving 2 already-delivered");
    expect(protocol).not.toMatch(/five (?:unique )?(?:validator )?runs/iu);
  });

  it("documents all three distinct pinned exit codes", () => {
    const protocol = repositoryFile(PROTOCOL_PATH);

    expect(new Set([EXIT_CLEAR, EXIT_USAGE_OR_IO, EXIT_CLASSIFIED]).size).toBe(
      3,
    );
    expect(protocol).toContain(`**${EXIT_CLEAR} — clear:**`);
    expect(protocol).toContain(`**${EXIT_CLASSIFIED} — classified:**`);
    expect(protocol).toContain(`**${EXIT_USAGE_OR_IO} — usage or I/O error:**`);
    expect(protocol).toContain("Exit 2 and exit 1 are intentionally distinct");
  });

  it("keeps the AGENTS pointer and package script wired", () => {
    const agents = repositoryFile("AGENTS.md");
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, unknown>;
    };

    expect(agents).toContain(PROTOCOL_PATH);
    expect(packageJson.scripts?.["rederivation:check"]).toBe(
      "tsx scripts/check-validation-cause.ts",
    );
  });

  it("keeps TypeScript and knip globs covering the module and script", () => {
    const knip = repositoryFile("knip.json");
    const tsconfig = repositoryFile("tsconfig.json");

    expect(knip).toContain('"scripts/*.ts"');
    expect(knip).toContain('"src/**/*.ts"');
    expect(tsconfig).toContain('"src/**/*.ts"');
    expect(tsconfig).toContain('"scripts/**/*.ts"');
  });
});
