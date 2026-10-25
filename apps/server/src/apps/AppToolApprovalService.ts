/** Stub until A6 and A20: every operation fails with `AppsNotImplemented`. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AppToolApprovalService, AppsNotImplemented } from "./services.ts";

const notImplemented = (method: string) =>
  new AppsNotImplemented({ service: "AppToolApprovalService", method });

export const layer = Layer.succeed(AppToolApprovalService)({
  request: () => Effect.fail(notImplemented("request")),
});
