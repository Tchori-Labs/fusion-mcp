import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, type SuiteCollector, type SuiteFactory } from "vitest";

const DEFAULT_LIVE_ITERATIONS = 10;
const REDACTION_MARKER = "[REDACTED]";
const enabledValues = new Set(["1", "true", "yes", "on"]);
const reportedSkipReasons = new Set<string>();

function configuredValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === "" ? undefined : value;
}

export function liveSkipReason(): string | undefined {
  const unmet: string[] = [];
  if (
    !enabledValues.has(configuredValue("FUSION_MCP_LIVE")?.toLowerCase() ?? "")
  ) {
    unmet.push("FUSION_MCP_LIVE must be set to one of: 1, true, yes, on");
  }
  if (configuredValue("FUSION_BASE_URL") === undefined) {
    unmet.push("FUSION_BASE_URL must name the reachable Fusion instance");
  }
  if (configuredValue("FUSION_TOKEN") === undefined) {
    unmet.push(
      "FUSION_TOKEN must be supplied from the environment or secret store",
    );
  }
  return unmet.length === 0 ? undefined : unmet.join("; ");
}

export function describeLive(
  name: string,
  factory: SuiteFactory,
): SuiteCollector {
  const reason = liveSkipReason();
  if (reason !== undefined && !reportedSkipReasons.has(reason)) {
    reportedSkipReasons.add(reason);
    process.stderr.write(`fusion-mcp live suite skipped: ${reason}.\n`);
  }
  return describe.skipIf(reason !== undefined)(name, factory);
}

export function liveIterations(): number {
  const raw = configuredValue("FUSION_MCP_LIVE_ITERATIONS");
  if (raw === undefined) {
    return DEFAULT_LIVE_ITERATIONS;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error("FUSION_MCP_LIVE_ITERATIONS must be a positive integer");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      "FUSION_MCP_LIVE_ITERATIONS must be a safe positive integer",
    );
  }
  return parsed;
}

export function redactToken(
  text: string,
  token = configuredValue("FUSION_TOKEN"),
): string {
  if (token === undefined) {
    return text;
  }
  return text.replaceAll(token, REDACTION_MARKER);
}

export async function writeFailureTrace(
  name: string,
  capturedStdout: string,
  capturedStderr: string,
): Promise<string> {
  const safeName =
    name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "live";
  const path = join(
    tmpdir(),
    `fusion-mcp-${safeName}-${process.pid}-${Date.now()}.log`,
  );
  const trace = redactToken(
    [
      `name=${safeName}`,
      "--- stdout ---",
      capturedStdout,
      "--- stderr ---",
      capturedStderr,
      "",
    ].join("\n"),
  );
  await writeFile(path, trace, { encoding: "utf8", mode: 0o600 });
  process.stderr.write(`fusion-mcp live failure trace (redacted): ${path}\n`);
  return path;
}

export function liveChildEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return { ...env, ...overrides };
}

export async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("could not reserve a loopback port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

export async function waitForLoopbackListener(
  port: number,
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        "HTTP MCP server exited before its listener became ready",
      );
    }
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the HTTP MCP loopback listener");
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 10_000,
): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise<ChildExit>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for the MCP server child to exit"));
    }, timeoutMs);
    timer.unref();
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

export interface CapturedChild {
  child: ChildProcessWithoutNullStreams;
  stdout(): string;
  stderr(): string;
}

export function spawnCapturedProcess(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): CapturedChild {
  const child = spawn(command, [...args], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  return {
    child,
    stdout: () => Buffer.concat(stdout).toString("utf8"),
    stderr: () => Buffer.concat(stderr).toString("utf8"),
  };
}
