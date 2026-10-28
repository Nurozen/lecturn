// @effect-diagnostics nodeBuiltinImport:off -- Tests the Promise API against real temp dirs, processes and sockets.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { discoverServer, serverRuntimeStatePath } from "./discovery.ts";

const homes: Array<string> = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => NodeFSP.rm(home, { recursive: true })));
});

async function tempHome() {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lecturn-embed-discovery-"));
  homes.push(home);
  return home;
}

async function writeState(
  home: string,
  variant: "userdata" | "dev",
  state: { pid: number; origin: string } | string,
) {
  const path = serverRuntimeStatePath(home, variant);
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const contents =
    typeof state === "string"
      ? state
      : JSON.stringify({
          version: 1,
          pid: state.pid,
          port: Number(new URL(state.origin).port),
          origin: state.origin,
          startedAt: "2026-10-25T00:00:00.000Z",
        });
  await NodeFSP.writeFile(path, contents);
}

const USERDATA = "http://127.0.0.1:41001";
const DEV = "http://127.0.0.1:41002";
const LIVE = 1001;
const DEAD = 1002;

function fakeFetch(answers: Record<string, unknown>) {
  const requested: Array<string> = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requested.push(url.toString());
    const body = answers[url.origin];
    if (body === undefined) throw new TypeError("fetch failed");
    if (typeof body === "number") return new Response("bad gateway", { status: body });
    return Response.json(body);
  }) as typeof globalThis.fetch;
  return { fetch, requested };
}

const options = (answers: Record<string, unknown>) => {
  const fake = fakeFetch(answers);
  return {
    fake,
    options: { fetch: fake.fetch, isProcessAlive: (pid: number) => pid === LIVE },
  };
};

describe("discoverServer", () => {
  it("prefers the userdata server over a dev server when both are live", async () => {
    const home = await tempHome();
    await writeState(home, "userdata", { pid: LIVE, origin: USERDATA });
    await writeState(home, "dev", { pid: LIVE, origin: DEV });
    const { options: discovery, fake } = options({
      [USERDATA]: { environmentId: "env-userdata" },
      [DEV]: { environmentId: "env-dev" },
    });

    const found = await discoverServer(home, discovery);

    expect(found).toMatchObject({
      variant: "userdata",
      origin: USERDATA,
      environmentId: "env-userdata",
    });
    expect(fake.requested).toEqual([`${USERDATA}/.well-known/lecturn/environment`]);
  });

  it("falls through to dev when the userdata record names a dead pid", async () => {
    const home = await tempHome();
    await writeState(home, "userdata", { pid: DEAD, origin: USERDATA });
    await writeState(home, "dev", { pid: LIVE, origin: DEV });
    const { options: discovery, fake } = options({
      [USERDATA]: { environmentId: "env-userdata" },
      [DEV]: { environmentId: "env-dev" },
    });

    const found = await discoverServer(home, discovery);

    expect(found).toMatchObject({ variant: "dev", environmentId: "env-dev" });
    // A dead owner's port may belong to another server now, so it is never probed.
    expect(fake.requested).toEqual([`${DEV}/.well-known/lecturn/environment`]);
  });

  it("skips a live pid whose origin does not answer as a Lecturn server", async () => {
    const home = await tempHome();
    await writeState(home, "userdata", { pid: LIVE, origin: USERDATA });
    await writeState(home, "dev", { pid: LIVE, origin: DEV });

    expect(await discoverServer(home, options({ [USERDATA]: 502, [DEV]: {} }).options)).toBe(null);
    expect(await discoverServer(home, options({}).options)).toBe(null);
  });

  it("ignores missing, empty and malformed records", async () => {
    const home = await tempHome();
    const answers = { [USERDATA]: { environmentId: "env" } };
    expect(await discoverServer(home, options(answers).options)).toBe(null);

    await writeState(home, "userdata", "");
    await writeState(home, "dev", '{"version":2,"pid":1001}');
    expect(await discoverServer(home, options(answers).options)).toBe(null);
  });

  it("limits the search to the requested variants", async () => {
    const home = await tempHome();
    await writeState(home, "dev", { pid: LIVE, origin: DEV });
    const { options: discovery } = options({ [DEV]: { environmentId: "env-dev" } });

    expect(await discoverServer(home, { ...discovery, variants: ["userdata"] })).toBe(null);
  });

  it("never creates the ownership lock a starting server would race for", async () => {
    const home = await tempHome();
    await writeState(home, "userdata", { pid: LIVE, origin: USERDATA });
    await discoverServer(home, options({ [USERDATA]: { environmentId: "env" } }).options);

    expect(NodeFS.readdirSync(NodePath.join(home, "userdata"))).toEqual(["server-runtime.json"]);
  });
});
