// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@lecturn/shared/HostProcess";
import * as NetService from "@lecturn/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";

const testdata = NodePath.resolve(import.meta.dirname, "../squire/testdata");
const scenario05 = NodePath.join(testdata, "scenarios/05-merged-propose-thread.json");
const fake05 = NodePath.join(testdata, "fake/05-merged-propose-thread.json");

interface Recorded {
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/**
 * A stand-in for a running server: the fixture route answers 401 without a
 * credential when `gate` is open (as the real route does) and 404 when closed.
 */
const withFakeServer = <A, E, R>(
  gate: "open" | "closed",
  run: (origin: string, recorded: ReadonlyArray<Recorded>) => Effect.Effect<A, E, R>,
) => {
  const recorded: Array<Recorded> = [];
  return Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        let text = "";
        request.on("data", (chunk) => (text += chunk));
        request.on("end", () => {
          const body = text.length === 0 ? undefined : (JSON.parse(text) as { op?: string });
          recorded.push({ url: request.url, authorization: request.headers.authorization, body });
          if (gate === "closed" || request.url !== "/api/dev/squire/fixture") {
            response.writeHead(404).end();
            return;
          }
          if (request.headers.authorization === undefined) {
            response.writeHead(401).end();
            return;
          }
          const result =
            body?.op === "loadSetup"
              ? { squireId: "squire:fixture-release" }
              : body?.op === "inject"
                ? { sequence: 41 }
                : {};
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
        });
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return Effect.die(new Error("Expected a TCP address"));
      }
      return run(`http://127.0.0.1:${String(address.port)}`, recorded);
    },
    (server) => Effect.sync(() => server.close()),
  );
};

const tempDir = (label: string) =>
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `squire-cli-${label}-`)));

/** A linked worktree checkout, a fake `$HOME`, and an ambient `LECTURN_HOME`, all empty. */
const makeDirs = () => {
  const home = tempDir("home");
  const ambientHome = tempDir("ambient");
  const worktree = tempDir("worktree");
  NodeFS.writeFileSync(
    NodePath.join(worktree, ".git"),
    `gitdir: ${NodePath.join(tempDir("repo"), ".git", "worktrees", "squire")}\n`,
  );
  return { home, ambientHome, worktree, worktreeHome: NodePath.join(worktree, ".lecturn") };
};

const listTree = (root: string): ReadonlyArray<string> =>
  NodeFS.existsSync(root) ? NodeFS.readdirSync(root, { recursive: true }).map(String) : [];

const runIn = (dirs: ReturnType<typeof makeDirs>, cwd: string, args: ReadonlyArray<string>) => {
  const env = { HOME: dirs.home, LECTURN_HOME: dirs.ambientHome };
  return Command.runWith(cli, { version: "0.0.0" })(["squire", "load-fixture", ...args]).pipe(
    Effect.provideService(HostProcess.WorkingDirectory, cwd),
    Effect.provideService(HostProcess.HomeDirectory, dirs.home),
    Effect.provideService(HostProcess.Environment, env),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NetService.layer,
        TestConsole.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
  );
};

const rendered = (error: unknown) =>
  String(typeof error === "object" && error !== null && "cause" in error ? error.cause : error);

const persistState = (lecturnHome: string, origin: string) =>
  Effect.gen(function* () {
    yield* persistServerRuntimeState({
      path: NodePath.join(lecturnHome, "userdata", "server-runtime.json"),
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: Number(new URL(origin).port),
      }),
    });
  });

describe("lecturn squire load-fixture", () => {
  it.effect(
    "refuses outside a worktree without --base-dir and never touches the shared homes",
    () =>
      Effect.gen(function* () {
        const dirs = makeDirs();
        const error = yield* runIn(dirs, dirs.home, [scenario05]).pipe(Effect.flip);
        assert.include(rendered(error), "Pass --base-dir");
        assert.deepStrictEqual(listTree(dirs.home), []);
        assert.deepStrictEqual(listTree(dirs.ambientHome), []);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses when no server runs in the worktree home, writing nothing", () =>
    Effect.gen(function* () {
      const dirs = makeDirs();
      const error = yield* runIn(dirs, dirs.worktree, [scenario05]).pipe(Effect.flip);
      assert.include(rendered(error), "No running Lecturn server found");
      assert.include(rendered(error), NodePath.join(dirs.worktreeHome, "userdata"));
      assert.deepStrictEqual(listTree(dirs.worktreeHome), []);
      assert.deepStrictEqual(listTree(dirs.ambientHome), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses before issuing a session when the server does not serve fixtures", () =>
    withFakeServer("closed", (origin, recorded) =>
      Effect.gen(function* () {
        const dirs = makeDirs();
        yield* persistState(dirs.worktreeHome, origin);
        const error = yield* runIn(dirs, dirs.worktree, [scenario05]).pipe(Effect.flip);
        assert.include(rendered(error), "LECTURN_SQUIRE=1 LECTURN_TEST_PROVIDERS=1");
        // One unauthenticated probe, and no auth database, so no session was written.
        assert.deepStrictEqual(
          recorded.map((request) => request.authorization),
          [undefined],
        );
        assert.deepStrictEqual(listTree(dirs.worktreeHome), [
          "userdata",
          NodePath.join("userdata", "server-runtime.json"),
        ]);
        assert.deepStrictEqual(listTree(dirs.home), []);
        assert.deepStrictEqual(listTree(dirs.ambientHome), []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("loads a scenario through the route with --set and --fake-provider", () =>
    withFakeServer("open", (origin, recorded) =>
      Effect.gen(function* () {
        const dirs = makeDirs();
        yield* persistState(dirs.worktreeHome, origin);
        yield* runIn(dirs, dirs.worktree, [
          scenario05,
          "--fake-provider",
          fake05,
          "--set",
          "events.0.summary.pullRequest.number=321",
          "--set",
          "permissions.steer=auto",
        ]);
        const [probe, ...calls] = recorded;
        assert.strictEqual(probe?.authorization, undefined);
        assert.deepStrictEqual(
          calls.map((call) => (call.body as { readonly op: string }).op),
          ["loadSetup", "inject", "drainThrough"],
        );
        const token = calls[0]?.authorization;
        assert.match(token ?? "", /^Bearer \S+$/);
        assert.isTrue(calls.every((call) => call.authorization === token));

        const load = calls[0]?.body as {
          readonly setup: { readonly permissions: { readonly steer: string } };
          readonly set: Readonly<Record<string, unknown>>;
          readonly fake: { readonly steps: ReadonlyArray<unknown> };
        };
        // Setup paths reach the loader unapplied, so it knows what they name.
        // `auto` is not JSON, so it stays a string; 321 parses as a number.
        assert.deepStrictEqual(load.set, { "permissions.steer": "auto" });
        assert.notStrictEqual(load.setup.permissions.steer, "auto");
        assert.lengthOf(load.fake.steps, 1);
        const inject = calls[1]?.body as {
          readonly event: {
            readonly summary: { readonly pullRequest: { readonly number: unknown } };
          };
        };
        assert.strictEqual(inject.event.summary.pullRequest.number, 321);
        assert.deepStrictEqual(calls[2]?.body, { op: "drainThrough", sequence: 41 });

        // The session lives in the worktree home only.
        assert.deepStrictEqual(listTree(dirs.home), []);
        assert.deepStrictEqual(listTree(dirs.ambientHome), []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resets a fixture Squire by name without a file", () =>
    withFakeServer("open", (origin, recorded) =>
      Effect.gen(function* () {
        const dirs = makeDirs();
        yield* persistState(dirs.worktreeHome, origin);
        yield* runIn(dirs, dirs.worktree, ["--reset", "Research"]);
        assert.deepStrictEqual(
          recorded.slice(1).map((call) => call.body),
          [{ op: "reset", name: "Research" }],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
