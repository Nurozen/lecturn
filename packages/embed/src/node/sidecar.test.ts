// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Tests the Promise API against real temp dirs, processes and sockets.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { AppRegistration } from "@lecturn/contracts/apps";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { isProcessAlive, serverRuntimeStatePath } from "./discovery.ts";
import {
  buildSidecarEnv,
  SIDECAR_ENV_SCRUB,
  sidecarArgs,
  SidecarError,
  type SidecarHandle,
  startSidecar,
} from "./sidecar.ts";

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const encodeRegistration = Schema.encodeSync(AppRegistration);
const registration = Schema.decodeSync(AppRegistration)({
  appId: "dev.example.app",
  name: "Example",
  iconDataUrl: PNG_1PX,
  toolPrefix: "ex",
  refPrefixes: ["ex:"],
  liveTools: false,
  gatedTools: [],
});

// Stands in for the Lecturn server: it reads the envelope from fd 3, records
// what it was given, prints a startup token on stdout like `serve` does, and
// then behaves per FAKE_SIDECAR_MODE.
const FAKE_SERVER = String.raw`
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const args = process.argv.slice(2);
const baseDir = args[args.indexOf("--base-dir") + 1];
const envelope = await new Promise((resolve) => {
  let text = "";
  const input = fs.createReadStream(null, { fd: 3, encoding: "utf8" });
  input.on("data", (chunk) => (text += chunk));
  input.on("end", () => resolve(text));
  input.on("error", () => resolve(text));
});
fs.writeFileSync(
  process.env.FAKE_SIDECAR_OUT,
  JSON.stringify({
    args,
    cwd: process.cwd(),
    envelope: envelope.trim() ? JSON.parse(envelope) : null,
    envelopeLine: envelope.endsWith("\n"),
    pid: process.pid,
    parentPipe: (() => {
      try {
        const stat = fs.fstatSync(4);
        return stat.isSocket() || stat.isFIFO();
      } catch {
        return false;
      }
    })(),
    env: Object.fromEntries(
      ["ELECTRON_RUN_AS_NODE", "LECTURN_HOME", "LECTURN_PORT", "VITE_DEV_SERVER_URL", "KEEP_ME"].map(
        (key) => [key, process.env[key] ?? null],
      ),
    ),
  }),
);
process.stdout.write("Token: stdout-secret\n");

const writeRecord = (pid, origin) => {
  fs.mkdirSync(path.join(baseDir, "userdata"), { recursive: true });
  fs.writeFileSync(
    path.join(baseDir, "userdata", "server-runtime.json"),
    JSON.stringify({ version: 1, pid, port: Number(new URL(origin).port), origin, startedAt: new Date().toISOString() }),
  );
};

const mode = process.env.FAKE_SIDECAR_MODE;
if (mode === "owned") {
  // Another process won the lock and serves at FAKE_WINNER_ORIGIN.
  writeRecord(process.ppid, process.env.FAKE_WINNER_ORIGIN);
  process.exit(78);
} else if (mode === "starting") {
  // Never becomes ready: the host gives up while it is still starting.
  setInterval(() => {}, 1_000);
} else if (mode === "crash") {
  process.stderr.write("boom: could not open the database\nPairing URL: http://x/#token=stderr-secret\n");
  process.exit(3);
} else {
  const server = http.createServer((request, response) => {
    if (request.url === "/.well-known/lecturn/environment") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ environmentId: "env-sidecar" }));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  server.listen(0, "127.0.0.1", () => {
    writeRecord(process.pid, "http://127.0.0.1:" + server.address().port);
  });
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lecturn-embed-sidecar-"));
  cleanups.push(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const serverEntry = NodePath.join(root, "fake-server.mjs");
  await NodeFSP.writeFile(serverEntry, FAKE_SERVER);
  const out = NodePath.join(root, "received.json");
  const baseDir = NodePath.join(root, "sidecar-home");
  const received = async () =>
    JSON.parse(await NodeFSP.readFile(out, "utf8")) as {
      args: Array<string>;
      cwd: string;
      envelope: unknown;
      envelopeLine: boolean;
      pid: number;
      parentPipe: boolean;
      env: Record<string, string | null>;
    };
  const start = (
    mode: string,
    extraEnv: Record<string, string> = {},
    options: { readonly signal?: AbortSignal } = {},
  ) =>
    startSidecar({
      registration,
      sidecar: { serverEntry, baseDir, nodePath: process.execPath },
      readyTimeoutMs: 20_000,
      ...options,
      env: {
        PATH: process.env["PATH"],
        FAKE_SIDECAR_OUT: out,
        FAKE_SIDECAR_MODE: mode,
        ...extraEnv,
      },
    }).then((handle) => {
      if (handle.kind === "spawned") cleanups.push(handle.stop);
      return handle;
    });
  return { root, baseDir, out, received, start };
}

async function environmentServer(environmentId: string) {
  const server = NodeHttp.createServer((request, response) => {
    if (request.url !== "/.well-known/lecturn/environment") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ environmentId }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
}

const spawned = (handle: SidecarHandle) => {
  if (handle.kind !== "spawned") throw new Error(`expected a spawned sidecar, got ${handle.kind}`);
  return handle;
};

describe("sidecar environment and arguments", () => {
  it("drops every inherited value that would redirect the sidecar", () => {
    const inherited = Object.fromEntries(SIDECAR_ENV_SCRUB.map((key) => [key, "inherited"]));
    const env = buildSidecarEnv(
      { ...inherited, PATH: "/bin", HOME: "/home/a" },
      { electronAsNode: false },
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/a" });
  });

  it("runs only the server itself as Node when it borrows the Electron binary", () => {
    expect(
      buildSidecarEnv({ ELECTRON_RUN_AS_NODE: "0" }, { electronAsNode: true })[
        "ELECTRON_RUN_AS_NODE"
      ],
    ).toBe("1");
  });

  it("serves on loopback in its own home and lets web mode pick the port", () => {
    const args = sidecarArgs("/lecturn/bin.mjs", "/app/sidecar");
    expect(args).toEqual([
      "/lecturn/bin.mjs",
      "serve",
      "--base-dir",
      "/app/sidecar",
      "--host",
      "127.0.0.1",
      "--no-browser",
      "--bootstrap-fd",
      "3",
    ]);
    expect(args).not.toContain("--port");
  });
});

describe("startSidecar", () => {
  it("hands the envelope over fd 3 and becomes ready at the port the server recorded", async () => {
    const { baseDir, received, start } = await fixture();
    const handle = spawned(
      await start("serve", {
        LECTURN_HOME: "/Users/someone/.lecturn",
        LECTURN_PORT: "3773",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
        KEEP_ME: "yes",
      }),
    );

    const record = JSON.parse(
      await NodeFSP.readFile(serverRuntimeStatePath(baseDir, "userdata"), "utf8"),
    ) as { pid: number; origin: string };
    expect(handle).toMatchObject({
      origin: record.origin,
      pid: record.pid,
      environmentId: "env-sidecar",
    });

    const seen = await received();
    expect(seen.envelope).toEqual({
      mode: "app-sidecar",
      registration: encodeRegistration(registration),
      appSeedToken: handle.appSeedToken,
      parentPipeFd: 4,
    });
    expect(seen.envelopeLine).toBe(true);
    expect(seen.parentPipe).toBe(true);
    expect(seen.args).not.toContain("--port");
    expect(seen.cwd).toBe(NodeFS.realpathSync(baseDir));
    expect(seen.env).toEqual({
      ELECTRON_RUN_AS_NODE: null,
      LECTURN_HOME: null,
      LECTURN_PORT: null,
      VITE_DEV_SERVER_URL: null,
      KEEP_ME: "yes",
    });

    await handle.stop();
    expect(await handle.exited).toBe(0);
  });

  it("attaches to the owner when the server exits 78", async () => {
    const { start } = await fixture();
    const winner = await environmentServer("env-winner");

    const handle = await start("owned", { FAKE_WINNER_ORIGIN: winner });

    expect(handle).toEqual({
      kind: "attached",
      origin: winner,
      environmentId: "env-winner",
      pid: process.pid,
    });
  });

  it("attaches to a live owner of the base dir without spawning", async () => {
    const { baseDir, out, start } = await fixture();
    const owner = await environmentServer("env-owner");
    const statePath = serverRuntimeStatePath(baseDir, "userdata");
    await NodeFSP.mkdir(NodePath.dirname(statePath), { recursive: true });
    await NodeFSP.writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: Number(new URL(owner).port),
        origin: owner,
        startedAt: "2026-10-25T00:00:00.000Z",
      }),
    );

    const handle = await start("serve");

    expect(handle).toMatchObject({ kind: "attached", origin: owner, environmentId: "env-owner" });
    expect(NodeFS.existsSync(out)).toBe(false);
  });

  it("reports a failed start with the exit code and a redacted stderr tail", async () => {
    const { start } = await fixture();

    const error = await start("crash").then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(SidecarError);
    const failure = error as SidecarError;
    expect(failure.reason).toBe("exited");
    expect(failure.exitCode).toBe(3);
    expect(failure.message).toContain("boom: could not open the database");
    expect(failure.message).not.toContain("secret");
  });

  it("stops a sidecar that is still starting when aborted, and rejects only once it has exited", async () => {
    const { out, received, start } = await fixture();
    const controller = new AbortController();
    const starting = start("starting", {}, { signal: controller.signal }).then(
      () => null,
      (cause: unknown) => cause,
    );
    while (!NodeFS.existsSync(out)) await new Promise((resolve) => setTimeout(resolve, 20));
    const { pid } = await received();
    expect(isProcessAlive(pid)).toBe(true);

    controller.abort();
    const error = await starting;

    expect(error).toMatchObject({ name: "AbortError" });
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("spawns nothing for a signal that is already aborted", async () => {
    const { out, start } = await fixture();
    const reason = new Error("host quit");

    const error = await start("serve", {}, { signal: AbortSignal.abort(reason) }).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toBe(reason);
    expect(NodeFS.existsSync(out)).toBe(false);
  });
});
