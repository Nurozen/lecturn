import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ManagedAccessUnavailable } from "../billing/ManagedAccess.ts";

export interface GatewayEnrollmentMapping {
  readonly userId: string;
  readonly environmentId: string;
  readonly publicHostname: string;
  readonly originHostname: string;
  readonly originDnsRecordId: string | null;
  readonly generation: number;
  readonly deleting?: boolean;
}
interface Identity {
  readonly userId: string;
  readonly environmentId: string;
}
interface Generation extends Identity {
  readonly generation: number;
}
export type GatewayAllocationCheckpoint = Generation &
  (
    | { readonly step: "tunnel"; readonly tunnelId: string }
    | { readonly step: "dns"; readonly dnsRecordId: string }
    | { readonly step: "ready" }
  );
type Operation<A> = Effect.Effect<A, ManagedAccessUnavailable>;

/** Optional deployment service: absent preserves legacy provisioning, never gateway downgrade. */
export class ManagedGatewayEnrollment extends Context.Service<
  ManagedGatewayEnrollment,
  {
    readonly enabledFor: (userId: string) => Operation<boolean>;
    readonly get: (identity: Identity) => Operation<GatewayEnrollmentMapping | null>;
    readonly registerPending: (
      input: Identity & { readonly publicHostname: string; readonly originHostname: string },
    ) => Operation<GatewayEnrollmentMapping>;
    readonly checkpointAllocation: (input: GatewayAllocationCheckpoint) => Operation<boolean>;
    readonly recordOriginDns: (
      input: Generation & { readonly originDnsRecordId: string },
    ) => Operation<boolean>;
    readonly markReady: (input: Generation) => Operation<boolean>;
    readonly pause: (input: Generation) => Operation<boolean>;
    readonly remove: (input: Generation) => Operation<boolean>;
    readonly finalizeRemove: (input: Generation) => Operation<boolean>;
    readonly sync: (userId: string) => Operation<void>;
  }
>()("lecturn-relay/environments/ManagedGatewayEnrollment") {}
