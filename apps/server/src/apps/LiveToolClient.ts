/** Stub until A22: every operation fails with `AppsNotImplemented`. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { LiveToolClient, AppsNotImplemented } from "./services.ts";

const notImplemented = (method: string) =>
  new AppsNotImplemented({ service: "LiveToolClient", method });

export const layer = Layer.succeed(LiveToolClient)({
  listTools: () => Effect.fail(notImplemented("listTools")),
  call: () => Effect.fail(notImplemented("call")),
  readResource: () => Effect.fail(notImplemented("readResource")),
});
