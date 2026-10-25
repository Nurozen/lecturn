/** Stub until A13a: every operation fails with `AppsNotImplemented`. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { AppProjectService, AppsNotImplemented } from "./services.ts";

const notImplemented = (method: string) =>
  new AppsNotImplemented({ service: "AppProjectService", method });

export const layer = Layer.succeed(AppProjectService)({
  ensureWorkspace: () => Effect.fail(notImplemented("ensureWorkspace")),
  resolveAppForProject: () => Effect.fail(notImplemented("resolveAppForProject")),
  listThreads: () => Effect.fail(notImplemented("listThreads")),
  streamThreads: () => Stream.fail(notImplemented("streamThreads")),
  setThreadAppData: () => Effect.fail(notImplemented("setThreadAppData")),
  createEmbedThread: () => Effect.fail(notImplemented("createEmbedThread")),
  markThreadsCopied: () => Effect.fail(notImplemented("markThreadsCopied")),
});
