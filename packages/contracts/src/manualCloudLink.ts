import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";
import {
  RelayEnvironmentConfigRequest,
  RelayEnvironmentLinkProof,
  RelayLinkProofRequest,
  RelayManagedEndpoint,
} from "./relay.ts";

/** Manual registration runs on the selected authenticated host; it never provisions a tunnel. */
export const ManualCloudLinkProofInput = Schema.Struct({
  environmentId: EnvironmentId,
  challenge: RelayLinkProofRequest.fields.challenge,
  relayIssuer: RelayLinkProofRequest.fields.relayIssuer,
  endpoint: Schema.Struct({
    ...RelayManagedEndpoint.fields,
    providerKind: Schema.Literal("manual"),
  }),
});
export const ManualCloudLinkProofResult = Schema.Struct({
  environmentId: EnvironmentId,
  proof: Schema.NullOr(RelayEnvironmentLinkProof),
});
export const ManualCloudRelayConfigInput = Schema.Struct({
  ...RelayEnvironmentConfigRequest.fields,
  environmentId: EnvironmentId,
  endpointRuntime: Schema.Null,
});
export class ManualCloudLinkError extends Schema.TaggedErrorClass<ManualCloudLinkError>()(
  "ManualCloudLinkError",
  { message: Schema.String },
) {}
export type ManualCloudLinkProofInput = typeof ManualCloudLinkProofInput.Type;
export type ManualCloudLinkProofResult = typeof ManualCloudLinkProofResult.Type;
export type ManualCloudRelayConfigInput = typeof ManualCloudRelayConfigInput.Type;
