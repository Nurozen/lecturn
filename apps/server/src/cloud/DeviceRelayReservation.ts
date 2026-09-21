import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { acquireDeviceRelayLease, type DeviceRelayLease } from "./deviceRelayLease.ts";

const publicationStates = new WeakMap<ServerSecretStore.ServerSecretStore["Service"], boolean>();
export const deviceRelayPublicationBlocked = (
  store: ServerSecretStore.ServerSecretStore["Service"],
): boolean => publicationStates.get(store) === false;
export const setDeviceRelayPublicationActive = (
  store: ServerSecretStore.ServerSecretStore["Service"],
  active: boolean,
): void => {
  publicationStates.set(store, active);
};

const conflicts = new WeakMap<ServerSecretStore.ServerSecretStore["Service"], string>();
export const deviceRelayConflict = (
  store: ServerSecretStore.ServerSecretStore["Service"],
): string | null => conflicts.get(store) ?? null;
export function setDeviceRelayConflict(
  store: ServerSecretStore.ServerSecretStore["Service"],
  message: string | null,
): void {
  if (message) conflicts.set(store, message);
  else conflicts.delete(store);
}

export class DeviceRelayReservationError extends Schema.TaggedErrorClass<DeviceRelayReservationError>()(
  "DeviceRelayReservationError",
  { message: Schema.String },
) {}

export class DeviceRelayReservation extends Context.Service<
  DeviceRelayReservation,
  {
    readonly acquire: Effect.Effect<DeviceRelayLease, DeviceRelayReservationError>;
  }
>()("lecturn/cloud/DeviceRelayReservation") {}

export const layer = Layer.effect(
  DeviceRelayReservation,
  Effect.gen(function* () {
    const environment = yield* ServerEnvironment.ServerEnvironment;
    return DeviceRelayReservation.of({
      acquire: Effect.gen(function* () {
        const descriptor = yield* environment.getDescriptor;
        return yield* Effect.tryPromise({
          try: () =>
            acquireDeviceRelayLease({
              environmentId: descriptor.environmentId,
              label: descriptor.label,
              pid: process.pid,
            }),
          catch: (error) =>
            new DeviceRelayReservationError({
              message: error instanceof Error ? error.message : String(error),
            }),
        });
      }),
    });
  }),
);
