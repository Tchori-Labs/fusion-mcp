import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const installedMarker = Symbol.for(
  "fusion-mcp.loopback-network-guard.installed",
);
const hermeticMarker = Symbol.for(
  "fusion-mcp.hermetic-network-guard.installed",
);

export type LoopbackNetworkOperation =
  "TCP connect" | "TLS connect" | "UDP connect" | "UDP send" | "DNS lookup";

export function isPermittedLoopbackDestination(destination: unknown): boolean {
  return destination === "127.0.0.1";
}

export class LoopbackNetworkError extends Error {
  readonly operation: LoopbackNetworkOperation;
  readonly destination: string;

  constructor(operation: LoopbackNetworkOperation, destination: unknown) {
    const attempted =
      typeof destination === "string" && destination !== ""
        ? destination
        : "<unspecified>";
    super(
      `Socket test guard: ${operation} to ${attempted} is blocked; only literal 127.0.0.1 is permitted.`,
    );
    this.name = "LoopbackNetworkError";
    this.operation = operation;
    this.destination = attempted;
  }
}

function destinationFromConnectArguments(args: readonly unknown[]): unknown {
  const first = args[0];
  if (Array.isArray(first)) {
    return destinationFromConnectArguments(first);
  }
  if (typeof first === "object" && first !== null) {
    const options = first as {
      host?: unknown;
      hostname?: unknown;
      path?: unknown;
    };
    return options.host ?? options.hostname ?? options.path;
  }
  if (typeof args[1] === "string") {
    return args[1];
  }
  return undefined;
}

function requireLoopback(
  operation: LoopbackNetworkOperation,
  destination: unknown,
): void {
  if (!isPermittedLoopbackDestination(destination)) {
    throw new LoopbackNetworkError(operation, destination);
  }
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

function guardedConnect(
  operation: "TCP connect" | "TLS connect",
  original: (...args: never[]) => unknown,
): (...args: never[]) => unknown {
  return function (this: unknown, ...args: never[]): unknown {
    requireLoopback(operation, destinationFromConnectArguments(args));
    return original.apply(this, args);
  };
}

function dnsDestination(args: readonly unknown[]): unknown {
  return args[0];
}

function patchDnsMethods(target: object, promiseBased: boolean): void {
  for (const property of Object.getOwnPropertyNames(target)) {
    if (
      property === "lookup" ||
      property === "lookupService" ||
      property === "reverse" ||
      property.startsWith("resolve")
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(target, property);
      const original = descriptor?.value;
      replaceMethod(
        target,
        property,
        property === "lookup" && original instanceof Function
          ? function (this: unknown, ...args: never[]): unknown {
              const destination = dnsDestination(args);
              // Node's listen/connect internals pass numeric literals through
              // dns.lookup without issuing a DNS query. Preserve that no-DNS
              // fast path so literal loopback sockets remain usable.
              requireLoopback("DNS lookup", destination);
              return original.apply(this, args);
            }
          : promiseBased
            ? async (...args: never[]) => {
                throw new LoopbackNetworkError(
                  "DNS lookup",
                  dnsDestination(args),
                );
              }
            : (...args: never[]) => {
                throw new LoopbackNetworkError(
                  "DNS lookup",
                  dnsDestination(args),
                );
              },
      );
    }
  }
}

/** Installs an irreversible, process-local guard for the socket-test worker. */
export function installLoopbackGuard(): void {
  const processState = globalThis as unknown as Record<PropertyKey, unknown>;
  if (processState[installedMarker] === true) {
    return;
  }
  processState[installedMarker] = true;

  const socketConnect = net.Socket.prototype.connect;
  const netConnect = net.connect;
  const createConnection = net.createConnection;
  const tlsConnect = tls.connect;

  replaceMethod(
    net.Socket.prototype,
    "connect",
    guardedConnect("TCP connect", socketConnect as never),
  );
  replaceMethod(
    net,
    "connect",
    guardedConnect("TCP connect", netConnect as never),
  );
  replaceMethod(
    net,
    "createConnection",
    guardedConnect("TCP connect", createConnection as never),
  );
  replaceMethod(
    tls,
    "connect",
    guardedConnect("TLS connect", tlsConnect as never),
  );
  replaceMethod(dgram.Socket.prototype, "connect", (...args: never[]) => {
    throw new LoopbackNetworkError("UDP connect", args[1] ?? args[0]);
  });
  replaceMethod(dgram.Socket.prototype, "send", (...args: never[]) => {
    throw new LoopbackNetworkError("UDP send", args.at(-1));
  });
  replaceMethod(dgram.Socket.prototype, "sendto", (...args: never[]) => {
    throw new LoopbackNetworkError("UDP send", args.at(-1));
  });

  patchDnsMethods(dns, false);
  patchDnsMethods(dns.promises, true);
  patchDnsMethods(dns.Resolver.prototype, false);
  patchDnsMethods(dns.promises.Resolver.prototype, true);
  syncBuiltinESMExports();
}

// The mandatory suite installs its stronger guard before test modules load.
// Everywhere else this file is loaded only as the socket lane's setup file.
const processState = globalThis as unknown as Record<PropertyKey, unknown>;
if (processState[hermeticMarker] !== true) {
  installLoopbackGuard();
}
