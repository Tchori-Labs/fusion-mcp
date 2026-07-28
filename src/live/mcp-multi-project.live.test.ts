import { access } from "node:fs/promises";
import type { Readable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";

import {
  describeLive,
  edgeCredentialsConfigured,
  liveChildEnvironment,
  redactToken,
  waitForCondition,
  writeFailureTrace,
} from "./live-harness.js";

const serverEntryPoint = "dist/index.js";

interface StdioProcessInternals {
  _process?: { stdout: Readable | null };
}

class CapturingStdioClientTransport extends StdioClientTransport {
  readonly stdoutChunks: Buffer[] = [];

  override async start(): Promise<void> {
    await super.start();
    const child = (this as unknown as StdioProcessInternals)._process;
    if (child?.stdout === null || child?.stdout === undefined) {
      throw new Error(
        "stdio transport did not expose the spawned server stdout",
      );
    }
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.stdoutChunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      );
    });
  }

  capturedStdout(): string {
    return Buffer.concat(this.stdoutChunks).toString("utf8");
  }
}

interface CapturedSession {
  client: Client;
  transport: CapturingStdioClientTransport;
  capturedStderr(): string;
}

interface ProjectRecord {
  id: string;
}

interface TaskRecord {
  id: string;
  projectId?: string;
}

function safeError(error: unknown): string {
  return redactToken(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
}

function assertSensitiveValuesAbsent(label: string, text: string): void {
  for (const [name, value] of [
    ["FUSION_TOKEN", process.env.FUSION_TOKEN],
    ["FUSION_CF_ACCESS_CLIENT_ID", process.env.FUSION_CF_ACCESS_CLIENT_ID],
    [
      "FUSION_CF_ACCESS_CLIENT_SECRET",
      process.env.FUSION_CF_ACCESS_CLIENT_SECRET,
    ],
  ] as const) {
    if (value !== undefined && value.trim() !== "" && text.includes(value)) {
      throw new Error(`${name} appeared in captured ${label}`);
    }
  }
}

function textResult(toolName: string, result: unknown): unknown {
  if (
    typeof result !== "object" ||
    result === null ||
    ("isError" in result && result.isError === true) ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error(`${toolName} did not return successful MCP content`);
  }
  const first: unknown = result.content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("type" in first) ||
    first.type !== "text" ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    throw new Error(`${toolName} did not return text content`);
  }
  return JSON.parse(first.text) as unknown;
}

function parseProjects(result: unknown): ProjectRecord[] {
  if (
    typeof result !== "object" ||
    result === null ||
    !("projects" in result) ||
    !Array.isArray(result.projects)
  ) {
    throw new Error("list_projects did not return a projects array");
  }

  return result.projects.map((project, index) => {
    if (
      typeof project !== "object" ||
      project === null ||
      !("id" in project) ||
      typeof project.id !== "string" ||
      project.id.trim() === ""
    ) {
      throw new Error(
        `list_projects returned an invalid project at index ${index}`,
      );
    }
    return { id: project.id };
  });
}

function parseTasks(toolName: string, result: unknown): TaskRecord[] {
  if (
    typeof result !== "object" ||
    result === null ||
    !("tasks" in result) ||
    !Array.isArray(result.tasks)
  ) {
    throw new Error(`${toolName} did not return a tasks array`);
  }

  return result.tasks.map((task, index) => {
    if (
      typeof task !== "object" ||
      task === null ||
      !("id" in task) ||
      typeof task.id !== "string" ||
      task.id.trim() === ""
    ) {
      throw new Error(`${toolName} returned an invalid task at index ${index}`);
    }
    return task as TaskRecord;
  });
}

function assertTaskScope(
  tasks: readonly TaskRecord[],
  projectId: string,
): void {
  for (const task of tasks) {
    if (task.projectId !== undefined && task.projectId !== projectId) {
      throw new Error(
        `list_tasks(${projectId}) returned task ${task.id} attributed to project ${task.projectId}`,
      );
    }
  }
}

async function callJsonTool(
  session: CapturedSession,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await session.client.callTool({
    name: toolName,
    arguments: args,
  });
  return textResult(toolName, result);
}

async function runCapturedJourney(
  name: string,
  overrides: Record<string, string>,
  body: (session: CapturedSession) => Promise<void>,
): Promise<void> {
  try {
    await access(serverEntryPoint);
  } catch {
    throw new Error(
      "dist/index.js is missing; run `pnpm build` before `pnpm test:live`",
    );
  }

  const transport = new CapturingStdioClientTransport({
    command: process.execPath,
    args: [serverEntryPoint, "--stdio"],
    env: liveChildEnvironment(overrides),
    stderr: "pipe",
  });
  const stderrChunks: Buffer[] = [];
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  const capturedStderr = (): string =>
    Buffer.concat(stderrChunks).toString("utf8");
  const client = new Client({
    name: `fusion-mcp-live-${name}`,
    version: "1.0.0",
  });
  const session: CapturedSession = { client, transport, capturedStderr };
  let failure: unknown;

  try {
    await client.connect(transport);
    await body(session);

    const stdout = transport.capturedStdout();
    if (stdout.includes("tool=")) {
      throw new Error("audit or diagnostic output appeared on stdio stdout");
    }
    assertSensitiveValuesAbsent(`${name} stdout`, stdout);
    assertSensitiveValuesAbsent(`${name} stderr`, capturedStderr());
  } catch (error) {
    failure = error;
  } finally {
    try {
      await client.close();
    } catch (error) {
      failure ??= error;
      await transport.close().catch(() => undefined);
    }
  }

  if (failure !== undefined) {
    const path = await writeFailureTrace(
      name,
      transport.capturedStdout(),
      `${capturedStderr()}\n--- failure ---\n${safeError(failure)}`,
    );
    throw new Error(
      `${name} live journey failed; inspect redacted trace: ${path}`,
    );
  }
}

describeLive("live MCP multi-project scoping", () => {
  it("scopes explicit and default-project task reads across multiple projects", async () => {
    let explicitDefaultProjectTasks: TaskRecord[] = [];
    let defaultProjectId = "";
    let taskForScopedReads: TaskRecord | undefined;

    await runCapturedJourney("multi-project-explicit", {}, async (session) => {
      const projects = parseProjects(
        await callJsonTool(session, "list_projects", {}),
      );
      const [projectA, projectB] = projects;
      if (
        projectA === undefined ||
        projectB === undefined ||
        projectA.id === projectB.id
      ) {
        throw new Error(
          "list_projects did not return two distinct project ids",
        );
      }

      const explicitProjectATasks = parseTasks(
        "list_tasks(project A)",
        await callJsonTool(session, "list_tasks", {
          projectId: projectA.id,
          limit: 200,
          offset: 0,
        }),
      );
      const explicitProjectBTasks = parseTasks(
        "list_tasks(project B)",
        await callJsonTool(session, "list_tasks", {
          projectId: projectB.id,
          limit: 200,
          offset: 0,
        }),
      );
      assertTaskScope(explicitProjectATasks, projectA.id);
      assertTaskScope(explicitProjectBTasks, projectB.id);

      if (explicitProjectATasks.length > 0) {
        defaultProjectId = projectA.id;
        explicitDefaultProjectTasks = explicitProjectATasks;
      } else if (explicitProjectBTasks.length > 0) {
        defaultProjectId = projectB.id;
        explicitDefaultProjectTasks = explicitProjectBTasks;
      } else {
        throw new Error(
          "The live-integration environment must expose at least one task in its first two projects so task-scoped projectId propagation can be verified",
        );
      }

      taskForScopedReads = explicitDefaultProjectTasks[0];
      if (taskForScopedReads === undefined) {
        throw new Error(
          "could not select a task for project-scoped live reads",
        );
      }

      const taskResult = await callJsonTool(session, "get_task", {
        id: taskForScopedReads.id,
        projectId: defaultProjectId,
      });
      if (
        typeof taskResult !== "object" ||
        taskResult === null ||
        !("task" in taskResult) ||
        typeof taskResult.task !== "object" ||
        taskResult.task === null ||
        !("id" in taskResult.task)
      ) {
        throw new Error(
          "get_task(explicit project) did not return a task object",
        );
      }
      expect(taskResult.task.id).toBe(taskForScopedReads.id);
      if (
        "projectId" in taskResult.task &&
        taskResult.task.projectId !== undefined
      ) {
        expect(taskResult.task.projectId).toBe(defaultProjectId);
      }

      // These sub-resource tools were the failing #80 paths: unlike get_task,
      // omitting projectId made a multi-project board return an error or silent
      // empty data. A successful explicit call catches that propagation class.
      await callJsonTool(session, "get_task_workflow_results", {
        id: taskForScopedReads.id,
        projectId: defaultProjectId,
      });
      await callJsonTool(session, "get_task_logs", {
        id: taskForScopedReads.id,
        projectId: defaultProjectId,
        limit: 1,
        offset: 0,
      });

      await waitForCondition(
        () => session.capturedStderr().includes("tool=list_tasks"),
        "multi-project list_tasks audit line",
      );
      assertSensitiveValuesAbsent(
        "multi-project stderr",
        session.capturedStderr(),
      );
    });

    const scopedTask = taskForScopedReads;
    if (scopedTask === undefined) {
      throw new Error(
        "explicit journey did not resolve a task for the default-project journey",
      );
    }
    const expectedScopeIds = new Set(
      explicitDefaultProjectTasks.map((task) => task.id),
    );

    // A second child receives the chosen project as its default. With projectId
    // omitted from every request, default-project fallback must reproduce the
    // same task scope and keep the task-subresource reads working.
    await runCapturedJourney(
      "multi-project-default",
      { FUSION_DEFAULT_PROJECT_ID: defaultProjectId },
      async (session) => {
        const defaultScopedTasks = parseTasks(
          "list_tasks(default project)",
          await callJsonTool(session, "list_tasks", { limit: 200, offset: 0 }),
        );
        assertTaskScope(defaultScopedTasks, defaultProjectId);
        expect(new Set(defaultScopedTasks.map((task) => task.id))).toEqual(
          expectedScopeIds,
        );

        const defaultTaskResult = await callJsonTool(session, "get_task", {
          id: scopedTask.id,
        });
        if (
          typeof defaultTaskResult !== "object" ||
          defaultTaskResult === null ||
          !("task" in defaultTaskResult) ||
          typeof defaultTaskResult.task !== "object" ||
          defaultTaskResult.task === null ||
          !("id" in defaultTaskResult.task)
        ) {
          throw new Error(
            "get_task(default project) did not return a task object",
          );
        }
        expect(defaultTaskResult.task.id).toBe(scopedTask.id);
        if (
          "projectId" in defaultTaskResult.task &&
          defaultTaskResult.task.projectId !== undefined
        ) {
          expect(defaultTaskResult.task.projectId).toBe(defaultProjectId);
        }

        await callJsonTool(session, "get_task_workflow_results", {
          id: scopedTask.id,
        });
        await callJsonTool(session, "get_task_logs", {
          id: scopedTask.id,
          limit: 1,
          offset: 0,
        });

        await waitForCondition(
          () => session.capturedStderr().includes("tool=list_tasks"),
          "default-project list_tasks audit line",
        );
        assertSensitiveValuesAbsent(
          "default-project stderr",
          session.capturedStderr(),
        );
      },
    );
  });

  it("reads through the authenticated edge when service-token credentials are configured", async () => {
    if (!edgeCredentialsConfigured()) {
      // The optional CF Access service-token pair is not configured, so there
      // is no authenticated-edge request-header path to exercise here.
      return;
    }

    await runCapturedJourney("authenticated-edge", {}, async (session) => {
      const projects = parseProjects(
        await callJsonTool(session, "list_projects", {}),
      );
      expect(
        projects.length,
        "authenticated-edge read must still see the multi-project board",
      ).toBeGreaterThanOrEqual(2);

      await waitForCondition(
        () => session.capturedStderr().includes("tool=list_projects"),
        "authenticated-edge list_projects audit line",
      );
      assertSensitiveValuesAbsent(
        "authenticated-edge stderr",
        session.capturedStderr(),
      );
    });
  });
});
