/**
 * Every connected-app service, built once. server.ts provides this on the
 * outer pipe of its routes so the WebSocket and MCP transports share one
 * instance; a second build would split the lease and process state.
 *
 * Services are stacked in tiers: a service may depend on any service in a
 * lower tier, never on its own tier or above. Reactions that would point
 * upwards subscribe to a stream instead (HeadlessToolHost stops an app's
 * processes from `AppRegistryService.streamStatus`). A new upward edge is an
 * interface change, not an edit to a single service file.
 */
import * as Layer from "effect/Layer";

import * as AppToolkit from "../mcp/toolkits/app/AppToolkit.ts";
import * as AppAuthorization from "./appAuthorization.ts";
import * as AppHostContextStore from "./AppHostContextStore.ts";
import * as AppLeaseService from "./AppLeaseService.ts";
import * as AppProjectService from "./AppProjectService.ts";
import * as AppRegistryService from "./AppRegistryService.ts";
import * as AppToolApprovalService from "./AppToolApprovalService.ts";
import * as HeadlessToolHost from "./HeadlessToolHost.ts";
import * as LiveToolClient from "./LiveToolClient.ts";
import * as ThreadCopyService from "./ThreadCopyService.ts";

/** State and clients that know nothing about other app services. */
const tier0 = Layer.mergeAll(
  AppLeaseService.layer,
  AppHostContextStore.layer,
  LiveToolClient.layer,
);

/** App projects and threads; below the registry because deleting an app deletes its threads. */
const tier1 = AppProjectService.layer;

/** Registrations, grants and cached tool definitions. */
const tier2 = AppRegistryService.layer;

/** Everything that acts for a granted app. */
const tier3 = Layer.mergeAll(
  HeadlessToolHost.layer,
  AppAuthorization.layer,
  AppToolApprovalService.layer,
  ThreadCopyService.layer,
);

/** The MCP face of all of the above. */
const tier4 = AppToolkit.layer;

export const layer = tier4.pipe(
  Layer.provideMerge(tier3),
  Layer.provideMerge(tier2),
  Layer.provideMerge(tier1),
  Layer.provideMerge(tier0),
);

export type AppsServices = Layer.Success<typeof layer>;
