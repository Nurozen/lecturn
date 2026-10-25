/**
 * The per-socket RPC middleware. Scopes say what kind of call a session may
 * make; for `app:` and `embed:` sessions `AppAuthorization` then decides which
 * projects it may touch. Every other session gets the plain scope layer, so
 * ordinary clients pay nothing per call.
 */
import {
  EnvironmentAuthorizationError,
  RpcScopeAuthorization,
  authScopeRequiredResponse,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { AppAuthorization } from "./services.ts";
import { parseAppSubject } from "./subjects.ts";

export const layer = (
  session: AuthenticatedSession,
): Layer.Layer<RpcScopeAuthorization, never, AppAuthorization> =>
  parseAppSubject(session.subject) === null
    ? RpcAuthorization.layer(session.scopes)
    : Layer.effect(
        RpcScopeAuthorization,
        Effect.gen(function* () {
          const apps = yield* AppAuthorization;
          const checkScopes = yield* RpcScopeAuthorization.pipe(
            Effect.provide(RpcAuthorization.layer(session.scopes)),
          );
          return (effect, options) => {
            const method = options.rpc._tag;
            const authorized = apps.authorizeRpc(session, method, options.payload).pipe(
              Effect.catchTags({
                // An unfinished check denies rather than lets the call through.
                AppsNotImplemented: () => {
                  const requiredScope = RpcAuthorization.requiredScopeForRpcMethod(method);
                  return Effect.fail(
                    new EnvironmentAuthorizationError({
                      message: `Connected apps cannot call ${method} yet.`,
                      ...authScopeRequiredResponse(requiredScope),
                    }),
                  );
                },
              }),
            );
            return checkScopes(Effect.andThen(authorized, effect), options);
          };
        }),
      );
