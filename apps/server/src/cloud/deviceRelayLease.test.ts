// @effect-diagnostics nodeBuiltinImport:off - crash recovery needs a real owned child and SIGKILL, not scoped cleanup.
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "vite-plus/test";
import { acquireDeviceRelayLease, DeviceRelayBusyError } from "./deviceRelayLease.ts";

const owner = (environmentId: string) => ({
  environmentId,
  label: `Install ${environmentId}`,
  pid: process.pid,
});

it("excludes a second home and reports the owning installation, then allows transfer", async () => {
  const first = await acquireDeviceRelayLease(owner("stable"), 0);
  try {
    await expect(acquireDeviceRelayLease(owner("nightly"), first.port)).rejects.toMatchObject({
      name: "DeviceRelayBusyError",
      owner: owner("stable"),
    });
  } finally {
    await first.release();
  }
  const next = await acquireDeviceRelayLease(owner("nightly"), first.port);
  await next.release();
});

it("only one simultaneous claimant acquires the released reservation", async () => {
  const probe = await acquireDeviceRelayLease(owner("probe"), 0);
  await probe.release();
  const results = await Promise.allSettled([
    acquireDeviceRelayLease(owner("first"), probe.port),
    acquireDeviceRelayLease(owner("second"), probe.port),
  ]);
  try {
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason instanceof DeviceRelayBusyError).toBe(
      true,
    );
  } finally {
    await Promise.all(
      results.map((result) =>
        result.status === "fulfilled" ? result.value.release() : Promise.resolve(),
      ),
    );
  }
});

it("the kernel releases a crashed process reservation without stale PID cleanup", async () => {
  // This test owns this child and an ephemeral port; it never touches a real relay.
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "-e",
      `
    const server = require('node:net').createServer(socket => socket.end());
    server.listen({host:'127.0.0.1',port:0,exclusive:true}, () => process.send(server.address().port));
  `,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("message", (value) =>
        typeof value === "number" ? resolve(value) : reject(new Error("Invalid test port")),
      );
    });
    expect(typeof port).toBe("number");
    await expect(acquireDeviceRelayLease(owner("new"), port)).rejects.toBeInstanceOf(
      DeviceRelayBusyError,
    );
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    const recovered = await acquireDeviceRelayLease(owner("new"), port);
    await recovered.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
