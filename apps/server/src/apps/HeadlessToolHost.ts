/** Stub until A15: operations that need the real service fail with `AppsNotImplemented`. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HeadlessToolHost, AppsNotImplemented } from "./services.ts";

const notImplemented = (method: string) =>
  new AppsNotImplemented({ service: "HeadlessToolHost", method });

export const layer = Layer.succeed(HeadlessToolHost)({
  acquire: () => Effect.fail(notImplemented("acquire")),
  listTools: () => Effect.fail(notImplemented("listTools")),
  call: () => Effect.fail(notImplemented("call")),
  refreshDefinitions: () => Effect.fail(notImplemented("refreshDefinitions")),
  listForEmptyCache: () => Effect.fail(notImplemented("listForEmptyCache")),
  // Nothing runs yet, so there is nothing to stop.
  stopApp: () => Effect.void,
});
