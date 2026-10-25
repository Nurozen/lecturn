import { APPS_WS_METHODS as M, AppsError } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

// Every apps method is mounted on the WebSocket group by the contracts; until
// the apps services exist, each one answers with a typed refusal.
const unavailable = () =>
  new AppsError({ code: "unavailable", message: "Connected apps are not available yet." });
const call = () => Effect.fail(unavailable());
const stream = () => Stream.fail(unavailable());

export const appsRpcHandlers = {
  [M.appsList]: call,
  [M.appsSubscribeStatus]: stream,
  [M.appsDecidePairing]: call,
  [M.appsRevoke]: call,
  [M.appsSetRuntimeCeiling]: call,
  [M.appsDelete]: call,
  [M.appsSubscribeEmbedContext]: stream,
  [M.appsCreateEmbedThread]: call,
  [M.appsEnsureWorkspace]: call,
  [M.appsSetLiveLease]: call,
  [M.appsClearLiveLease]: call,
  [M.appsMintEmbedToken]: call,
  [M.appsUpdateHostContext]: call,
  [M.appsExportThreads]: call,
  [M.appsImportThreads]: call,
  [M.appsListThreads]: call,
  [M.appsSubscribeThreads]: stream,
  [M.appsSetThreadAppData]: call,
  [M.appsMarkThreadsCopied]: call,
};
