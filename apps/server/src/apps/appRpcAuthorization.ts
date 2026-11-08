/**
 * Per-socket RPC middleware: for `app:` and `embed:` sessions `AppAuthorization` decides which
 * projects a call may touch after the scope check. Every other session gets the plain scope layer,
 * so ordinary clients pay nothing per call. `onAuthorized` passes through for both.
 */
import { RpcScopeAuthorization } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { AppAuthorization } from "./services.ts";
import { parseAppSubject } from "./subjects.ts";

export const layer = (
  session: AuthenticatedSession,
  onAuthorized?: (method: string, payload: unknown) => Effect.Effect<void>,
): Layer.Layer<RpcScopeAuthorization, never, AppAuthorization> =>
  parseAppSubject(session.subject) === null
    ? RpcAuthorization.layer(session.scopes, onAuthorized)
    : Layer.effect(
        RpcScopeAuthorization,
        Effect.gen(function* () {
          const apps = yield* AppAuthorization;
          const checkScopes = yield* RpcScopeAuthorization.pipe(
            Effect.provide(RpcAuthorization.layer(session.scopes, onAuthorized)),
          );
          return (effect, options) => {
            const method = options.rpc._tag;
            const authorized = apps.authorizeRpc(session, method, options.payload);
            return checkScopes(Effect.andThen(authorized, effect), options);
          };
        }),
      );
