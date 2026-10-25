/** Stub until A12: every operation fails with `AppsNotImplemented`. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { AppRegistryService, AppsNotImplemented } from "./services.ts";

const notImplemented = (method: string) =>
  new AppsNotImplemented({ service: "AppRegistryService", method });

export const layer = Layer.succeed(AppRegistryService)({
  createPairingRequest: () => Effect.fail(notImplemented("createPairingRequest")),
  pollPairingRequest: () => Effect.fail(notImplemented("pollPairingRequest")),
  decidePairing: () => Effect.fail(notImplemented("decidePairing")),
  revoke: () => Effect.fail(notImplemented("revoke")),
  delete: () => Effect.fail(notImplemented("delete")),
  setRuntimeCeiling: () => Effect.fail(notImplemented("setRuntimeCeiling")),
  list: Effect.fail(notImplemented("list")),
  streamStatus: Stream.fail(notImplemented("streamStatus")),
  get: () => Effect.fail(notImplemented("get")),
  isGranted: () => Effect.fail(notImplemented("isGranted")),
  cachedTools: () => Effect.fail(notImplemented("cachedTools")),
  setCachedTools: () => Effect.fail(notImplemented("setCachedTools")),
  seedSidecarGrant: () => Effect.fail(notImplemented("seedSidecarGrant")),
  streamEmbedContext: () => Stream.fail(notImplemented("streamEmbedContext")),
});
