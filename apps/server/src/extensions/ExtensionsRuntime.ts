import { ContextualError, type ExtensionsHelperRequest } from "@lecturn/contracts";
import {
  HostProcessArchitecture,
  HostProcessHostname,
  HostProcessPlatform,
} from "@lecturn/shared/hostProcess";
import { Context, Effect, Layer, Path, Semaphore } from "effect";
import { ServerConfig } from "../config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import {
  ExtensionsSupervisor,
  type ExtensionsPayloads,
  type ExtensionsResults,
} from "./ExtensionsSupervisor.ts";

type Operation = ExtensionsHelperRequest["operation"];
const unavailable = () =>
  new ContextualError({
    code: "unavailable",
    message: "The Contextual helper is unavailable on this host. Saved Decisions remain available.",
  });
/** Serialize the helper's single-operation protocol without dropping overlapping UI reads. */
export const makeHelperRequestGate = Effect.gen(function* () {
  const permit = yield* Semaphore.make(1);
  return <A>(operation: Effect.Effect<A, ContextualError>) =>
    operation.pipe(
      permit.withPermits(1),
      Effect.timeout("30 seconds"),
      Effect.mapError(unavailable),
    );
});
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  const identity = yield* ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const hostName = yield* HostProcessHostname;
  const supervisor = config.extensions
    ? yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new ExtensionsSupervisor({
              bundledRoot: config.extensions!.bundledRoot,
              ...(config.extensions!.reviewBinary
                ? { reviewBinary: config.extensions!.reviewBinary }
                : {}),
              ...(config.extensions!.reviewBinary?.fixtureRoot
                ? { fixtureRoot: config.extensions!.reviewBinary.fixtureRoot }
                : {}),
              platform,
              architecture,
              homeDir: path.join(config.stateDir, "extensions"),
              exportsDir: path.join(config.stateDir, "extension-exports"),
              environmentId,
              hostName,
            }),
        ),
        (owned) => Effect.sync(() => owned.close()),
      )
    : null;
  const gate = yield* makeHelperRequestGate;
  const request = <O extends Operation>(
    operation: O,
    payload: ExtensionsPayloads[O],
  ): Effect.Effect<ExtensionsResults[O], ContextualError> =>
    supervisor
      ? Effect.tryPromise({
          try: (signal) => supervisor.request<O>(operation, payload, signal),
          catch: unavailable,
        }).pipe(gate)
      : Effect.fail(unavailable());
  const describe = supervisor
    ? Effect.tryPromise({ try: () => supervisor.start(), catch: unavailable })
    : Effect.succeed(null);
  const readExport = (artifactId: string) =>
    supervisor
      ? Effect.tryPromise({ try: () => supervisor.readExport(artifactId), catch: unavailable })
      : Effect.fail(unavailable());
  return { request, describe, readExport, hostName, environmentId };
});
export class ExtensionsRuntime extends Context.Service<
  ExtensionsRuntime,
  Effect.Success<typeof make>
>()("lecturn/extensions/ExtensionsRuntime") {}
export const layer = Layer.effect(ExtensionsRuntime, make);
