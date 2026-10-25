/**
 * Pending connected-app tool approvals, keyed by runtime request id (D1).
 *
 * State only. A gated MCP tool call registers its request and waits here
 * (`McpHttpServer` branch); the user's answer arrives as
 * `runtime-request.respond` and the effect worker's `RuntimeRequestService`
 * resolves it instead of calling a provider adapter (orchestration branch).
 * Those two branches share no service, so RuntimeLayer provides this once and
 * both sides, plus AppsLayer, resolve the same instance. The approval logic
 * (`AppToolApprovalService`) depends on this, never the reverse, so
 * orchestration never depends on the toolkit.
 */
import type { ProviderApprovalDecision, RuntimeRequestId } from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import type { AppToolApprovalOutcome } from "./services.ts";

export class AppToolApprovalRegistry extends Context.Service<
  AppToolApprovalRegistry,
  {
    /**
     * Claims `requestId` for the caller's scope; closing the scope (the tool
     * call ended) releases the claim. A second claim on a live id is a defect.
     */
    readonly register: (requestId: RuntimeRequestId) => Effect.Effect<void, never, Scope.Scope>;
    /** First outcome wins. False when nobody is waiting or it was already decided. */
    readonly resolve: (
      requestId: RuntimeRequestId,
      outcome: AppToolApprovalOutcome,
    ) => Effect.Effect<boolean>;
    /** True while a registered call holds the claim, decided or not. */
    readonly claims: (requestId: RuntimeRequestId) => Effect.Effect<boolean>;
    /** Waits for the outcome of a request the caller registered. */
    readonly awaitDecision: (requestId: RuntimeRequestId) => Effect.Effect<AppToolApprovalOutcome>;
  }
>()("lecturn/apps/AppToolApprovalRegistry") {}

/** How a user's answer to an app approval reads; anything but an accept fails closed. */
export const outcomeFromDecision = (
  decision: ProviderApprovalDecision | undefined,
): AppToolApprovalOutcome => {
  switch (decision) {
    case "accept":
    case "acceptForSession":
    case "acceptAlways":
      return "approved";
    case "cancel":
      return "cancelled";
    case "decline":
    case undefined:
      return "declined";
  }
};

const make = Effect.gen(function* () {
  const pending = yield* Ref.make<
    ReadonlyMap<RuntimeRequestId, Deferred.Deferred<AppToolApprovalOutcome>>
  >(new Map());

  // A wait that outlives the server would hang its MCP call; end it as cancelled.
  yield* Effect.addFinalizer(() =>
    Ref.get(pending).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries.values(), (deferred) => Deferred.succeed(deferred, "cancelled"), {
          discard: true,
        }),
      ),
    ),
  );

  const register = (requestId: RuntimeRequestId) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<AppToolApprovalOutcome>();
        const added = yield* Ref.modify(pending, (entries) =>
          entries.has(requestId)
            ? [false, entries]
            : [true, new Map(entries).set(requestId, deferred)],
        );
        if (!added) {
          return yield* Effect.die(
            new Error(`App tool approval ${requestId} is already registered.`),
          );
        }
        return deferred;
      }),
      (deferred) =>
        Deferred.succeed(deferred, "cancelled").pipe(
          Effect.andThen(
            Ref.update(pending, (entries) => {
              if (entries.get(requestId) !== deferred) return entries;
              const next = new Map(entries);
              next.delete(requestId);
              return next;
            }),
          ),
        ),
    ).pipe(Effect.asVoid);

  const lookup = (requestId: RuntimeRequestId) =>
    Ref.get(pending).pipe(Effect.map((entries) => entries.get(requestId)));

  return AppToolApprovalRegistry.of({
    register,
    resolve: (requestId, outcome) =>
      lookup(requestId).pipe(
        Effect.flatMap((deferred) =>
          deferred === undefined ? Effect.succeed(false) : Deferred.succeed(deferred, outcome),
        ),
      ),
    claims: (requestId) => lookup(requestId).pipe(Effect.map((deferred) => deferred !== undefined)),
    awaitDecision: (requestId) =>
      lookup(requestId).pipe(
        Effect.flatMap((deferred) =>
          deferred === undefined
            ? Effect.die(new Error(`App tool approval ${requestId} was never registered.`))
            : Deferred.await(deferred),
        ),
      ),
  });
});

export const layer = Layer.effect(AppToolApprovalRegistry, make);
