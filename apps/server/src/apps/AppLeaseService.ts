/** Stub until A12: operations that need the real service fail with `AppsNotImplemented`. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { AppLeaseService, AppsNotImplemented } from "./services.ts";

const notImplemented = (method: string) =>
  new AppsNotImplemented({ service: "AppLeaseService", method });

export const layer = Layer.succeed(AppLeaseService)({
  set: () => Effect.fail(notImplemented("set")),
  clear: () => Effect.fail(notImplemented("clear")),
  // No lease is the truthful answer while leases cannot be set.
  current: () => Effect.succeedNone,
  stream: Stream.empty,
});
