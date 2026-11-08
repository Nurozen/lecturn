import { Persistence } from "@lecturn/client-runtime/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PullRequestRoutingPermissions } from "@lecturn/client-runtime/connection";
import {
  makeBrowserPullRequestRoutingPermissions,
  makeCatalogServices,
  makeCatalogStore,
} from "../connection/storage";

/** A catalog that never reaches storage: it starts empty and is gone with the page. */
const MEMORY_CATALOG_BACKEND = {
  read: Effect.succeed(null),
  write: () => Effect.void,
};

const noCacheEntry = Effect.fn("EmbedConnectionStorage.noCacheEntry")(function () {
  return Effect.succeedNone;
});
const noCacheWrite = Effect.fn("EmbedConnectionStorage.noCacheWrite")(function () {
  return Effect.void;
});

const NO_CACHE = Persistence.EnvironmentCacheStore.of({
  loadShell: noCacheEntry,
  saveShell: noCacheWrite,
  loadThread: noCacheEntry,
  saveThread: noCacheWrite,
  removeThread: noCacheWrite,
  loadServerConfig: noCacheEntry,
  saveServerConfig: noCacheWrite,
  loadVcsRefs: noCacheEntry,
  saveVcsRefs: noCacheWrite,
  removeVcsRefs: noCacheWrite,
  clearVcsRefs: noCacheWrite,
  clear: noCacheWrite,
});

/**
 * Stands in for the IndexedDB connection storage under /embed. That database is shared with the
 * user's own Lecturn tab on this origin: reading it would connect the embed to the user's saved
 * environments with their credentials, and the embed's project-scoped shell would overwrite the
 * user's cached one. The embed reaches only its primary environment, with its own token.
 */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const catalog = yield* makeCatalogStore(MEMORY_CATALOG_BACKEND);
    return makeCatalogServices(catalog).pipe(
      Context.add(PullRequestRoutingPermissions, makeBrowserPullRequestRoutingPermissions()),
      Context.add(Persistence.EnvironmentCacheStore, NO_CACHE),
    );
  }),
);
