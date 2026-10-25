/**
 * Stub until A14. Only `app:` and `embed:` sessions reach this service, and
 * until A14 lands they are denied everything (default deny), so the stub can
 * never widen access.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AppAuthorization, AppsNotImplemented } from "./services.ts";

const notImplemented = (method: string) =>
  new AppsNotImplemented({ service: "AppAuthorization", method });

export const layer = Layer.succeed(AppAuthorization)({
  authorizeRpc: () => Effect.fail(notImplemented("authorizeRpc")),
  filterShellItem: () => Effect.succeedNone,
  authorizeHttp: () => Effect.fail(notImplemented("authorizeHttp")),
  mintEmbedToken: () => Effect.fail(notImplemented("mintEmbedToken")),
});
