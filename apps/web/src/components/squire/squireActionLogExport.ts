import { EnvironmentSupervisor } from "@lecturn/client-runtime/connection";
import { ManagedRelay } from "@lecturn/client-runtime/relay";
import { createEnvironmentCommand } from "@lecturn/client-runtime/state/runtime";
import type { SquireId } from "@lecturn/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient, HttpClient } from "effect/http";

import { connectionAtomRuntime } from "../../connection/runtime";
import { squireActionLogUrl } from "./squireActionLogExport.logic";

class SquireActionLogExportError extends Data.TaggedError("SquireActionLogExportError")<{
  readonly message: string;
}> {}

const fail = (message: string) => new SquireActionLogExportError({ message });

/**
 * P14.1: fetches the read-scoped NDJSON export with the environment's own credentials. A plain
 * link carries only a same-origin cookie, so a remote, bearer, or relayed (DPoP) environment
 * would refuse it; this signs the request the way the Contextual export download does.
 */
export const squireActionLogExport = createEnvironmentCommand(connectionAtomRuntime, {
  label: "squire:action-log-export",
  execute: ({ squireId }: { readonly squireId: SquireId }) =>
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(prepared)) {
        return yield* fail("Reconnect this environment to export the action log.");
      }
      const connection = prepared.value;
      const url = squireActionLogUrl(connection.httpBaseUrl, squireId);
      const authorization = connection.httpAuthorization;
      const headers: Record<string, string> = {};
      if (authorization?._tag === "Bearer") {
        headers.authorization = `Bearer ${authorization.token}`;
      } else if (authorization?._tag === "Dpop") {
        const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
        if (Option.isNone(signer)) {
          return yield* fail("This connection cannot authorize the export.");
        }
        headers.authorization = `DPoP ${authorization.accessToken}`;
        headers.dpop = yield* signer.value
          .createProof({ method: "GET", url, accessToken: authorization.accessToken })
          .pipe(Effect.mapError(() => fail("This connection cannot authorize the export.")));
      }
      const body = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(url, { headers });
        if (response.status !== 200) {
          return yield* fail(
            response.status === 404
              ? "This Squire's action log was not found."
              : "The action log could not be exported with this connection.",
          );
        }
        return yield* response.arrayBuffer;
      }).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          credentials: authorization === null ? "include" : "omit",
          cache: "no-store",
          redirect: "error",
        }),
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError((error) =>
          error._tag === "SquireActionLogExportError"
            ? error
            : fail("Could not reach the environment to export the action log."),
        ),
      );
      return new Blob([body], { type: "application/x-ndjson" });
    }).pipe(Effect.timeout("60 seconds")),
});
