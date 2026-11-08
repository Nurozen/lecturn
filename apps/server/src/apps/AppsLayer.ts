/**
 * Every connected-app service, built once: server.ts provides it on the outer pipe so WebSocket and
 * MCP share one instance (a second build splits lease and process state). A service depends only on
 * lower tiers; upward reactions subscribe to `AppRegistryService.streamStatus`. State orchestration
 * also reaches (AppToolApprovalRegistry, AppRuntimeState) comes from RuntimeLayer.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as AppToolkit from "../mcp/toolkits/app/AppToolkit.ts";
import * as AppAuthorization from "./appAuthorization.ts";
import * as AppHostContextStore from "./AppHostContextStore.ts";
import * as AppLeaseService from "./AppLeaseService.ts";
import * as AppProjectService from "./AppProjectService.ts";
import * as AppRegistryService from "./AppRegistryService.ts";
import { AppRuntimeState } from "./AppRuntimeState.ts";
import * as AppToolApprovalService from "./AppToolApprovalService.ts";
import * as HeadlessToolHost from "./HeadlessToolHost.ts";
import * as LiveToolClient from "./LiveToolClient.ts";
import * as ThreadCopyService from "./ThreadCopyService.ts";

const singleBuild = Layer.effectDiscard(
  Effect.gen(function* () {
    const { appsLayerBuilt } = yield* AppRuntimeState;
    yield* Effect.acquireRelease(
      Ref.getAndSet(appsLayerBuilt, true).pipe(
        Effect.flatMap((built) =>
          built
            ? Effect.die(
                new Error(
                  "AppsLayer was built twice over one AppRuntimeState; provide it once, on the outer pipe.",
                ),
              )
            : Effect.void,
        ),
      ),
      () => Ref.set(appsLayerBuilt, false),
    );
  }),
);

/** State and clients that know nothing about other app services. */
const tier0 = Layer.mergeAll(
  singleBuild,
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
