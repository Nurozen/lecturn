import { connectMultiAccount } from "../cloud/publicConfig";
import * as Effect from "effect/Effect";

import type { SavedRemoteConnection } from "../../lib/connection";
import { linkEnvironmentToCloudWithPreference } from "../cloud/linkEnvironment";
import { updateAgentAwarenessRegistrationPreferences } from "./remoteRegistration";

export const setLiveActivityUpdatesEnabled = Effect.fn("setLiveActivityUpdatesEnabled")(
  function* (input: {
    readonly enabled: boolean;
    readonly previousEnabled: boolean;
    readonly clerkToken: string | null;
    readonly accountId?: string;
    readonly connections: ReadonlyArray<SavedRemoteConnection>;
  }) {
    const linkedConnections = input.connections.filter(
      (connection) => connection.bearerToken !== null,
    );

    const updateRelayPreference = Effect.fn("updateRelayPreference")(function* (enabled: boolean) {
      yield* updateAgentAwarenessRegistrationPreferences({
        liveActivitiesEnabled: enabled,
      });

      const clerkToken = input.clerkToken;
      if (!connectMultiAccount && !clerkToken) return;

      yield* Effect.forEach(
        linkedConnections,
        (connection) =>
          linkEnvironmentToCloudWithPreference({
            clerkToken: clerkToken ?? "",
            ...(input.accountId ? { accountId: input.accountId } : {}),
            connection,
            liveActivitiesEnabled: enabled,
          }),
        { concurrency: "unbounded" },
      );
    });

    const restoreRelayPreference = Effect.fn("restoreRelayPreference")(function* () {
      yield* updateAgentAwarenessRegistrationPreferences({
        liveActivitiesEnabled: input.previousEnabled,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not restore Live Activity device preference.", cause),
        ),
      );

      const clerkToken = input.clerkToken;
      if (!connectMultiAccount && !clerkToken) return;

      yield* Effect.forEach(
        linkedConnections,
        (connection) =>
          linkEnvironmentToCloudWithPreference({
            clerkToken: clerkToken ?? "",
            ...(input.accountId ? { accountId: input.accountId } : {}),
            connection,
            liveActivitiesEnabled: input.previousEnabled,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Could not restore Live Activity preference for environment ${connection.environmentId}.`,
                cause,
              ),
            ),
          ),
        { concurrency: "unbounded" },
      );
    });

    yield* updateRelayPreference(input.enabled).pipe(
      Effect.onError(() => restoreRelayPreference()),
    );
  },
);
