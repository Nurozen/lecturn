import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { isSecureRelayUrl } from "@lecturn/shared/relayUrl";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  CLOUD_LINKED_ORGANIZATION_ID,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";

export const EnvironmentTeamPolicy = Schema.Struct({
  organizationId: Schema.String,
  hasAccess: Schema.Boolean,
  allowedProviders: Schema.NullOr(Schema.Array(Schema.String)),
  publishAgentActivity: Schema.Boolean,
});
export class TeamPolicyError extends Schema.TaggedErrorClass<TeamPolicyError>()("TeamPolicyError", {
  message: Schema.String,
}) {}
export class TeamPolicy extends Context.Service<
  TeamPolicy,
  {
    readonly canPublishActivity: Effect.Effect<boolean, TeamPolicyError>;
    readonly checkProvider: (provider: string) => Effect.Effect<void, TeamPolicyError>;
  }
>()("lecturn/cloud/TeamPolicy") {}

export function assertProviderPolicy(
  organizationId: string,
  provider: string,
  policy: typeof EnvironmentTeamPolicy.Type | null,
): Effect.Effect<void, TeamPolicyError> {
  if (!policy || policy.organizationId !== organizationId || !policy.hasAccess)
    return Effect.fail(
      new TeamPolicyError({
        message:
          "Company Connect access is no longer active. Contact your organization administrator.",
      }),
    );
  if (policy.allowedProviders !== null && !policy.allowedProviders.includes(provider))
    return Effect.fail(
      new TeamPolicyError({ message: `Provider '${provider}' is disabled by your organization.` }),
    );
  return Effect.void;
}

export const TeamPolicyLive = Layer.effect(
  TeamPolicy,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    const http = yield* HttpClient.HttpClient;
    const read = (name: string) =>
      secrets
        .get(name)
        .pipe(
          Effect.map((value) =>
            Option.isSome(value) ? new TextDecoder().decode(value.value) : null,
          ),
        );
    const readPolicy = Effect.fn("TeamPolicy.readPolicy")(
      function* () {
        const organizationId = yield* read(CLOUD_LINKED_ORGANIZATION_ID);
        if (!organizationId) return null;
        const [url, credential] = yield* Effect.all([
          read(RELAY_URL_SECRET),
          read(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
        ]);
        if (!url || !credential || !isSecureRelayUrl(url))
          return yield* new TeamPolicyError({
            message:
              "Could not verify your organization's managed settings. Reconnect Lecturn Connect and try again.",
          });
        const response = yield* HttpClientRequest.get(
          `${url.replace(/\/$/, "")}/v1/teams/environment-policy`,
        ).pipe(
          HttpClientRequest.bearerToken(credential),
          http.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.NullOr(EnvironmentTeamPolicy))),
          Effect.timeout("10 seconds"),
        );
        if (!response || response.organizationId !== organizationId || !response.hasAccess)
          return yield* new TeamPolicyError({
            message:
              "Company Connect access is no longer active. Contact your organization administrator.",
          });
        return response;
      },
      Effect.mapError((cause) =>
        Schema.is(TeamPolicyError)(cause)
          ? cause
          : new TeamPolicyError({
              message:
                "Could not verify your organization's managed settings. Check your connection and try again.",
            }),
      ),
    );
    return {
      canPublishActivity: readPolicy().pipe(
        Effect.map((policy) => policy === null || policy.publishAgentActivity),
      ),
      checkProvider: Effect.fn("TeamPolicy.checkProvider")(function* (provider: string) {
        const policy = yield* readPolicy();
        if (policy) yield* assertProviderPolicy(policy.organizationId, provider, policy);
      }),
    };
  }),
);
