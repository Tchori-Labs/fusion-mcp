import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const installedMarker = Symbol.for("fusion-mcp.hermetic-network-guard.installed");

export const HERMETIC_NETWORK_ERROR_MESSAGE =
  "Hermetic test guard: outbound network is blocked in the mandatory 'pnpm test' suite. Inject a fake fetch (FetchLike) or use InMemoryTransport; run networked checks via the opt-in live suite (see SPEC.md).";

export type NetworkOperation =
  | "TCP connect"
  | "TLS connect"
  | "UDP connect"
  | "UDP send"
  | "DNS lookup";

export class HermeticNetworkError extends Error {
  readonly operation: NetworkOperation;

  constructor(operation: NetworkOperation) {
    super(`${HERMETIC_NETWORK_ERROR_MESSAGE} Attempted ${operation}.`);
    this.name = "HermeticNetworkError";
    this.operation = operation;
  }
}

function block(operation: NetworkOperation): never {
  throw new HermeticNetworkError(operation);
}

function replaceMethod(
  target: object,
  property: string,
  replacement: (...args: never[]) => unknown,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  if (descriptor?.value instanceof Function) {
    Object.defineProperty(target, property, {
      ...descriptor,
      value: replacement,
    });
  }
}

function patchDnsMethods(
  target: object,
  promiseBased: boolean,
): void {
  for (const property of Object.getOwnPropertyNames(target)) {
    if (
      property === "lookup" ||
      property === "lookupService" ||
      property === "reverse" ||
      property.startsWith("resolve")
    ) {
      replaceMethod(
        target,
        property,
        promiseBased
          ? async () => block("DNS lookup")
          : () => block("DNS lookup"),
      );
    }
  }
}

/** Installs an irreversible, process-local guard for the mandatory test worker. */
export function installNetworkGuard(): void {
  const processState = globalThis as unknown as Record<PropertyKey, unknown>;
  if (processState[installedMarker] === true) {
    return;
  }
  processState[installedMarker] = true;

  replaceMethod(net.Socket.prototype, "connect", () => block("TCP connect"));
  replaceMethod(net, "connect", () => block("TCP connect"));
  replaceMethod(net, "createConnection", () => block("TCP connect"));
  replaceMethod(tls, "connect", () => block("TLS connect"));
  replaceMethod(dgram.Socket.prototype, "connect", () => block("UDP connect"));
  replaceMethod(dgram.Socket.prototype, "send", () => block("UDP send"));
  replaceMethod(dgram.Socket.prototype, "sendto", () => block("UDP send"));

  patchDnsMethods(dns, false);
  patchDnsMethods(dns.promises, true);
  patchDnsMethods(dns.Resolver.prototype, false);
  patchDnsMethods(dns.promises.Resolver.prototype, true);

  // Keep node: built-in named ESM exports aligned with their patched default exports.
  syncBuiltinESMExports();
}

installNetworkGuard();
