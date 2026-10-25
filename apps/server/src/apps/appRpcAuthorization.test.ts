import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
  WS_METHODS,
  WsRpcGroup,
} from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import * as AppAuthorizationLayer from "./appAuthorization.ts";
import * as AppRpcAuthorization from "./appRpcAuthorization.ts";
import { AppAuthorization, AppsNotImplemented } from "./services.ts";

const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverProbe> =>
      tag !== WS_METHODS.serverProbe,
  ),
);

const session = (
  subject: string,
  scopes: ReadonlyArray<AuthEnvironmentScope> = [AuthOrchestrationReadScope],
): AuthenticatedSession => ({
  sessionId: AuthSessionId.make("session-1"),
  subject,
  method: "bearer-access-token",
  scopes,
});

const probe = (
  authenticated: AuthenticatedSession,
  appAuthorization: Layer.Layer<AppAuthorization>,
  handled: Array<string>,
) =>
  RpcTest.makeClient(group).pipe(
    Effect.provide(
      Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.serverProbe, () =>
          Effect.sync(() => handled.push("probe")).pipe(Effect.as({})),
        ),
        AppRpcAuthorization.layer(authenticated).pipe(Layer.provide(appAuthorization)),
      ),
    ),
    Effect.flatMap((client) => client[WS_METHODS.serverProbe]({})),
  );

const recordingAuthorization = (calls: Array<string>) =>
  Layer.succeed(AppAuthorization)({
    authorizeRpc: (_session, method) => Effect.sync(() => calls.push(method)),
    filterShellItem: (_session, item) => Effect.succeedSome(item),
    authorizeHttp: () => Effect.void,
    mintEmbedToken: () => Effect.die("unused"),
  });

// A3's project service stub: every lookup is unfinished.
const unfinished = () =>
  Effect.fail(new AppsNotImplemented({ service: "AppProjectService", method: "lookup" }));
const unfinishedAuthorization = Layer.succeed(AppAuthorization)(
  AppAuthorizationLayer.makeWith({
    resolveAppForProject: unfinished,
    projectIdForThread: unfinished,
    projectIdForNote: unfinished,
    issueEmbedSession: unfinished,
    environmentId: Effect.die("unused"),
    embedOrigin: "http://127.0.0.1:3773",
  }),
);

describe("app RPC authorization", () => {
  it.effect("never consults app authorization for ordinary sessions", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const handled: Array<string> = [];
      expect(yield* probe(session("owner"), recordingAuthorization(calls), handled)).toEqual({});
      expect(calls).toEqual([]);
      expect(handled).toEqual(["probe"]);
    }).pipe(Effect.scoped),
  );

  it.effect("denies an app session a method outside its allowlist", () =>
    Effect.gen(function* () {
      // server.probe is on the embed list (D31), so only the app credential is outside it here.
      const handled: Array<string> = [];
      const error = yield* probe(
        session("app:dev.example.app"),
        unfinishedAuthorization,
        handled,
      ).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      expect(handled).toEqual([]);
      expect(
        yield* probe(session("embed:dev.example.app:project-1"), unfinishedAuthorization, handled),
      ).toEqual({});
    }).pipe(Effect.scoped),
  );

  it.effect("checks scopes before asking app authorization", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const handled: Array<string> = [];
      const error = yield* probe(
        session("app:dev.example.app", []),
        recordingAuthorization(calls),
        handled,
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationReadScope,
      });
      expect(calls).toEqual([]);
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("runs the call once app authorization allows it", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const handled: Array<string> = [];
      expect(
        yield* probe(session("app:dev.example.app"), recordingAuthorization(calls), handled),
      ).toEqual({});
      expect(calls).toEqual([WS_METHODS.serverProbe]);
      expect(handled).toEqual(["probe"]);
    }).pipe(Effect.scoped),
  );
});
