/** Stub until A29: operations that need the real service fail with `AppsNotImplemented`. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AppHostContextStore, AppsNotImplemented } from "./services.ts";

const notImplemented = (method: string) =>
  new AppsNotImplemented({ service: "AppHostContextStore", method });

export const layer = Layer.succeed(AppHostContextStore)({
  set: () => Effect.fail(notImplemented("set")),
  forTurn: () => Effect.succeedNone,
});
