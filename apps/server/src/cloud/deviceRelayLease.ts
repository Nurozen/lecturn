import * as NodeNet from "node:net";

// One reservation across users, release channels, and data directories. The OS
// releases it after a crash; there are no PID files to race or stale locks to reap.
export const DEVICE_RELAY_LEASE_PORT = 47391;
const protocol = "lecturn-device-relay-v1";

export interface DeviceRelayOwner {
  readonly environmentId: string;
  readonly label: string;
  readonly pid: number;
}

export interface DeviceRelayLease {
  readonly port: number;
  readonly release: () => Promise<void>;
}

export class DeviceRelayBusyError extends Error {
  readonly owner: DeviceRelayOwner | null;
  constructor(owner: DeviceRelayOwner | null) {
    super(
      owner
        ? `This device's relay is already running in ${owner.label} (environment ${owner.environmentId}, process ${owner.pid}). Unlink it in that Lecturn installation's Relay settings before publishing here.`
        : "This device's relay reservation is already in use. Unlink the relay in the other Lecturn installation before publishing here, then retry.",
    );
    this.name = "DeviceRelayBusyError";
    this.owner = owner;
  }
}

function readOwner(port: number): Promise<DeviceRelayOwner | null> {
  return new Promise((resolve) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    let text = "";
    const finish = (owner: DeviceRelayOwner | null) => {
      socket.destroy();
      resolve(owner);
    };
    socket.setTimeout(500, () => finish(null));
    socket.on("error", () => finish(null));
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 2048) finish(null);
    });
    socket.on("end", () => {
      try {
        const value: unknown = JSON.parse(text);
        if (
          typeof value !== "object" ||
          value === null ||
          !("protocol" in value) ||
          value.protocol !== protocol ||
          !("owner" in value)
        )
          return finish(null);
        const owner = value.owner;
        if (
          typeof owner !== "object" ||
          owner === null ||
          !("environmentId" in owner) ||
          typeof owner.environmentId !== "string" ||
          !("label" in owner) ||
          typeof owner.label !== "string" ||
          !("pid" in owner) ||
          typeof owner.pid !== "number"
        )
          return finish(null);
        finish({ environmentId: owner.environmentId, label: owner.label, pid: owner.pid });
      } catch {
        finish(null);
      }
    });
  });
}

function close(server: NodeNet.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function acquireDeviceRelayLease(
  owner: DeviceRelayOwner,
  port = DEVICE_RELAY_LEASE_PORT,
): Promise<DeviceRelayLease> {
  const response = JSON.stringify({ protocol, owner });
  const server = NodeNet.createServer((socket) => {
    socket.setTimeout(500, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.end(response);
  });
  server.maxConnections = 8;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await close(server);
    if (error instanceof Error && "code" in error && error.code === "EADDRINUSE")
      throw new DeviceRelayBusyError(await readOwner(port));
    throw error;
  }
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    await close(server);
    throw new Error("Could not reserve this device's relay.");
  }
  return { port: address.port, release: () => close(server) };
}
