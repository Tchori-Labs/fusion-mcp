import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_FILE = "src/prose-hygiene.test.ts";
const ORGANIZATION_NAME = ["Tcho", "ri"].join("");
const INFRASTRUCTURE_VENDOR = ["cloud", "flare"].join("");
const REPOSITORY_COORDINATE = `${ORGANIZATION_NAME}-Labs/fusion-mcp`;
const PACKAGE_NAME = `@${ORGANIZATION_NAME.toLowerCase()}-labs/fusion-mcp`;

const DENIED_TERMS = [
  { id: "organization-name", pattern: /tchori/giu }, // prose-hygiene-allow: denylist self-reference
  { id: "infrastructure-vendor", pattern: /cloudflare/giu }, // prose-hygiene-allow: denylist self-reference
  { id: "container-technology", pattern: /LXC/giu }, // prose-hygiene-allow: denylist self-reference
] as const;

type DeniedTermId = (typeof DENIED_TERMS)[number]["id"];

type AllowedOccurrence = {
  path: string;
  term: DeniedTermId;
  line: string;
  justification: string;
  optional?: boolean;
};

const SELF_REFERENCE_SUFFIX =
  " // prose-hygiene-allow: denylist self-reference";

const ALLOWED_OCCURRENCES: readonly AllowedOccurrence[] = [
  {
    path: "LICENSE",
    term: "organization-name",
    line: `Copyright (c) 2026 ${ORGANIZATION_NAME} Labs`,
    justification: "Legal copyright ownership must remain unchanged.",
  },
  {
    path: "README.md",
    term: "organization-name",
    line: `MIT © ${ORGANIZATION_NAME} Labs — see [\`LICENSE\`](./LICENSE).`,
    justification: "License attribution mirrors the legal copyright notice.",
  },
  {
    path: "AGENTS.md",
    term: "organization-name",
    line:
      `- **PRs may target ONLY \`${REPOSITORY_COORDINATE}\`.** Never open a pull request`,
    justification: "The governed cross-repository protocol requires this coordinate.",
  },
  {
    path: "AGENTS.md",
    term: "organization-name",
    line: `  \`${REPOSITORY_COORDINATE}\`.`,
    justification: "The governed issue-target protocol requires this coordinate.",
  },
  {
    path: "package.json",
    term: "organization-name",
    line: `  "name": "${PACKAGE_NAME}",`,
    justification: "The published npm package uses the scoped organization name.",
  },
  {
    path: "package.json",
    term: "organization-name",
    line: `  "homepage": "https://github.com/${REPOSITORY_COORDINATE}#readme",`,
    justification: "Package homepage metadata points at the public repository.",
  },
  {
    path: "package.json",
    term: "organization-name",
    line: `    "url": "git+https://github.com/${REPOSITORY_COORDINATE}.git"`,
    justification: "Package repository metadata points at the public repository.",
  },
  {
    path: "package.json",
    term: "organization-name",
    line: `    "url": "https://github.com/${REPOSITORY_COORDINATE}/issues"`,
    justification: "Package bug-tracker metadata points at the public repository.",
  },
  {
    path: "src/project-tools.test.ts",
    term: "infrastructure-vendor",
    line:
      `          providers: { ${INFRASTRUCTURE_VENDOR}: { tunnelToken: secretMarker } },`,
    justification: "Realistic provider-key input verifies recursive secret redaction.",
    optional: true,
  },
  {
    path: "src/project-tools.test.ts",
    term: "infrastructure-vendor",
    line:
      `          providers: { ${INFRASTRUCTURE_VENDOR}: { tunnelToken: "[REDACTED]" } },`,
    justification: "Expected output preserves the provider key while redacting its secret.",
    optional: true,
  },
  ...DENIED_TERMS.map(({ id, pattern }) => ({
    path: TEST_FILE,
    term: id,
    line: `  { id: "${id}", pattern: ${pattern.toString()} },${SELF_REFERENCE_SUFFIX}`,
    justification: "The guard must name each denied term in its own definition.",
  })),
];

const EXCLUDED_PATHS = new Set(["pnpm-lock.yaml"]);
const EXCLUDED_PREFIXES = [
  ".fusion/",
  ".git/",
  ".worktrees/",
  "dist/",
  "node_modules/",
];

function trackedTextFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter(
      (path) =>
        !EXCLUDED_PATHS.has(path) &&
        !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)),
    )
    .sort();
}

describe("repository prose hygiene", () => {
  it("keeps organization and infrastructure names in justified metadata only", () => {
    const useCounts = ALLOWED_OCCURRENCES.map(() => 0);
    const violations: string[] = [];

    for (const path of trackedTextFiles()) {
      const content = readFileSync(`${REPOSITORY_ROOT}/${path}`);
      if (content.includes(0)) {
        continue;
      }

      const lines = content.toString("utf8").split(/\r?\n/u);
      lines.forEach((line, lineIndex) => {
        for (const term of DENIED_TERMS) {
          const matchCount = [...line.matchAll(term.pattern)].length;
          for (let occurrence = 0; occurrence < matchCount; occurrence += 1) {
            const allowanceIndex = ALLOWED_OCCURRENCES.findIndex(
              (allowance, index) =>
                allowance.path === path &&
                allowance.term === term.id &&
                allowance.line === line &&
                (useCounts[index] ?? 0) === 0,
            );

            if (allowanceIndex === -1) {
              violations.push(
                `${path}:${lineIndex + 1}: unexpected ${term.id}: ${line.trim()}`,
              );
            } else {
              useCounts[allowanceIndex] =
                (useCounts[allowanceIndex] ?? 0) + 1;
            }
          }
        }
      });
    }

    const missingRequiredAllowances = ALLOWED_OCCURRENCES.flatMap(
      (allowance, index) =>
        allowance.optional || (useCounts[index] ?? 0) === 1
          ? []
          : [
              `${allowance.path}: missing ${allowance.term} allowance (${allowance.justification})`,
            ],
    );

    expect([...violations, ...missingRequiredAllowances]).toEqual([]);
  });
});
