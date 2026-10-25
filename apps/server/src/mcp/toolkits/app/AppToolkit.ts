/** Stub until A15: every operation fails with `AppsNotImplemented`. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AppToolkit, AppsNotImplemented } from "../../../apps/services.ts";

const notImplemented = (method: string) =>
  new AppsNotImplemented({ service: "AppToolkit", method });

export const layer = Layer.succeed(AppToolkit)({
  listFor: () => Effect.fail(notImplemented("listFor")),
  call: () => Effect.fail(notImplemented("call")),
  readResource: () => Effect.fail(notImplemented("readResource")),
  cardToolCall: () => Effect.fail(notImplemented("cardToolCall")),
});
