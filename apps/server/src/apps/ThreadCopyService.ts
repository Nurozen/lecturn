/** Stub until A23: every operation fails with `AppsNotImplemented`. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadCopyService, AppsNotImplemented } from "./services.ts";

const notImplemented = (method: string) =>
  new AppsNotImplemented({ service: "ThreadCopyService", method });

export const layer = Layer.succeed(ThreadCopyService)({
  export: () => Effect.fail(notImplemented("export")),
  import: () => Effect.fail(notImplemented("import")),
});
