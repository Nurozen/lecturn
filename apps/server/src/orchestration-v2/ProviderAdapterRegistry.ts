import {
  ProviderInstanceId,
  ProviderSetupError,
  type OrchestrationV2ProviderCapabilities,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { ProviderAdapterDriverCreateError } from "@lecturn/provider-core/server/adapterDriver";
import * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";

const isProviderSetupError = Schema.is(ProviderSetupError);

export class ProviderAdapterRegistryLookupError extends Schema.TaggedError<ProviderAdapterRegistryLookupError>()(
  "ProviderAdapterRegistryLookupError",
  {
    instanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `No orchestration provider adapter is registered for ${this.instanceId}.`;
  }
}

export class ProviderAdapterRegistryMetadataError extends Schema.TaggedError<ProviderAdapterRegistryMetadataError>()(
  "ProviderAdapterRegistryMetadataError",
  { instanceId: ProviderInstanceId, cause: Schema.Defect() },
) {}

export const ProviderAdapterRegistryV2Error = Schema.Union([
  ProviderAdapterRegistryLookupError,
  ProviderAdapterRegistryMetadataError,
  ProviderAdapterDriverCreateError,
]);
export type ProviderAdapterRegistryV2Error = typeof ProviderAdapterRegistryV2Error.Type;

export interface ProviderAdapterRegistryV2Shape {
  readonly get: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapter.ProviderAdapterV2["Service"], ProviderAdapterRegistryV2Error>;
  readonly list: () => Effect.Effect<ReadonlyArray<ProviderInstanceId>>;
  readonly getMetadata?: (instanceId: ProviderInstanceId) => Effect.Effect<
    {
      readonly driver: ProviderAdapter.ProviderAdapterV2["Service"]["driver"];
      readonly continuationKey: string;
      readonly enabled: boolean;
      readonly capabilities: OrchestrationV2ProviderCapabilities;
    },
    ProviderAdapterRegistryV2Error
  >;
}

export class ProviderAdapterRegistryV2 extends Context.Service<
  ProviderAdapterRegistryV2,
  ProviderAdapterRegistryV2Shape
>()("lecturn/orchestration-v2/ProviderAdapterRegistry/ProviderAdapterRegistryV2") {}

/**
 * Lecturn: a provider whose executable is still being detected (or whose
 * detection failed) cannot open sessions yet. The gate wraps the sign-in
 * guard, so a detecting provider is rejected before auth admission.
 */
function gateProviderDiscovery(
  instance: Pick<ProviderInstance, "instanceId" | "snapshot">,
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    ...adapter,
    openSession: (input) =>
      instance.snapshot.getSnapshot.pipe(
        Effect.flatMap((current) => {
          const discovery = current.discovery;
          if (discovery === undefined || discovery.status === "ready") {
            return adapter.openSession(input);
          }
          return Effect.fail(
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: adapter.driver,
              providerSessionId: input.providerSessionId,
              cause: new ProviderSetupError({
                instanceId: instance.instanceId,
                operation: "session",
                detail:
                  discovery.status === "detecting"
                    ? "Provider detection is still running. Wait for detection to finish, or configure its executable path in Settings → Providers."
                    : "Provider detection did not finish successfully. Retry detection or configure its executable path in Settings → Providers.",
              }),
            }),
          );
        }),
      ),
  };
}

/** Gates an instance that reports provider discovery; others keep their adapter as-is. */
const withProviderDiscoveryGate = (
  instance: Pick<ProviderInstance, "instanceId" | "snapshot">,
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
): Effect.Effect<ProviderAdapter.ProviderAdapterV2["Service"]> =>
  instance.snapshot.getSnapshot.pipe(
    Effect.map((snapshot) =>
      snapshot.discovery === undefined ? adapter : gateProviderDiscovery(instance, adapter),
    ),
  );

export const layerFromProviderInstanceRegistry: Layer.Layer<
  ProviderAdapterRegistryV2,
  never,
  ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(
  ProviderAdapterRegistryV2,
  Effect.gen(function* () {
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    return ProviderAdapterRegistryV2.of({
      get: Effect.fn("ProviderAdapterRegistryV2.get")(function (instanceId) {
        return instances.getInstance(instanceId).pipe(
          Effect.flatMap((instance) => {
            if (instance === undefined)
              return new ProviderAdapterRegistryLookupError({ instanceId });
            const adapter = instance.orchestrationAdapter;
            const auth = instance.auth;
            if (!auth) return withProviderDiscoveryGate(instance, adapter);
            return withProviderDiscoveryGate(instance, {
              ...adapter,
              openSession: (input) => {
                const open = Effect.gen(function* () {
                  const binding = auth.credentialBinding;
                  const related = binding
                    ? (yield* instances.listInstances).filter(
                        (instance) =>
                          instance.auth?.credentialBinding?.key === binding.key &&
                          instance.auth.credentialBinding.owner === binding.owner,
                      )
                    : [instance];
                  for (const instance of related) {
                    if (
                      instance.auth?.isChangingCredentials &&
                      (yield* instance.auth.isChangingCredentials)
                    )
                      return yield* new ProviderSetupError({
                        instanceId,
                        operation: "session",
                        detail: "This provider's sign-in is changing. Try again after it finishes.",
                      });
                  }
                  let admitted: Effect.Effect<
                    ProviderAdapter.ProviderAdapterV2SessionRuntime,
                    ProviderAdapter.ProviderAdapterV2Error | ProviderSetupError,
                    Scope.Scope
                  > = adapter.openSession(input);
                  // Shared credential changes must interrupt a peer's startup too.
                  for (const peer of related) {
                    if (peer.auth?.withAccess) admitted = peer.auth.withAccess(admitted);
                  }
                  return yield* admitted;
                });
                return open.pipe(
                  Effect.mapError((cause) =>
                    isProviderSetupError(cause)
                      ? new ProviderAdapter.ProviderAdapterOpenSessionError({
                          driver: adapter.driver,
                          providerSessionId: input.providerSessionId,
                          cause,
                        })
                      : cause,
                  ),
                );
              },
            } satisfies ProviderAdapter.ProviderAdapterV2["Service"]);
          }),
        );
      }),
      list: Effect.fn("ProviderAdapterRegistryV2.list")(function () {
        return instances.listInstances.pipe(
          Effect.map((available) => available.map((instance) => instance.instanceId)),
        );
      }),
      getMetadata: Effect.fn("ProviderAdapterRegistry.getMetadata")(function* (instanceId) {
        const instance = yield* instances.getInstance(instanceId);
        if (instance === undefined) {
          return yield* new ProviderAdapterRegistryLookupError({ instanceId });
        }
        const capabilities = yield* instance.orchestrationAdapter
          .getCapabilities()
          .pipe(
            Effect.mapError(
              (cause) => new ProviderAdapterRegistryMetadataError({ instanceId, cause }),
            ),
          );
        return {
          driver: instance.driverKind,
          continuationKey: instance.continuationIdentity.continuationKey,
          enabled: instance.enabled,
          capabilities,
        };
      }),
    });
  }),
);

function makeRegistry(
  adapters: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>,
): ProviderAdapterRegistryV2Shape {
  return {
    get: Effect.fn("ProviderAdapterRegistry.get")(function* (instanceId) {
      const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
      if (!adapter) {
        return yield* new ProviderAdapterRegistryLookupError({ instanceId });
      }
      return adapter;
    }),
    list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
  };
}

export function layerFromAdapters(
  adapters: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>,
): Layer.Layer<ProviderAdapterRegistryV2> {
  return Layer.succeed(
    ProviderAdapterRegistryV2,
    ProviderAdapterRegistryV2.of(makeRegistry(adapters)),
  );
}

export function layerFromAdaptersEffect<R, E>(
  adapters: Effect.Effect<ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>, E, R>,
): Layer.Layer<ProviderAdapterRegistryV2, E, Exclude<R, Scope.Scope>> {
  return Layer.effect(
    ProviderAdapterRegistryV2,
    adapters.pipe(Effect.map((entries) => ProviderAdapterRegistryV2.of(makeRegistry(entries)))),
  );
}

export function layerSingle(
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
): Layer.Layer<ProviderAdapterRegistryV2> {
  return layerFromAdapters([adapter]);
}
