import { Persistence } from "@lecturn/client-runtime/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitHubRoutingPermissions } from "@lecturn/client-runtime/connection";
import {
  makeBrowserGitHubRoutingPermissions,
  makeCatalogServices,
  makeCatalogStore,
} from "../connection/storage";

/** A catalog that never reaches storage: it starts empty and is gone with the page. */
const MEMORY_CATALOG_BACKEND = {
  read: Effect.succeed(null),
  write: () => Effect.void,
};

const NO_CACHE = Persistence.EnvironmentCacheStore.of({
  loadShell: () => Effect.succeedNone,
  saveShell: () => Effect.void,
  loadThread: () => Effect.succeedNone,
  saveThread: () => Effect.void,
  removeThread: () => Effect.void,
  loadServerConfig: () => Effect.succeedNone,
  saveServerConfig: () => Effect.void,
  loadVcsRefs: () => Effect.succeedNone,
  saveVcsRefs: () => Effect.void,
  removeVcsRefs: () => Effect.void,
  clearVcsRefs: () => Effect.void,
  clear: () => Effect.void,
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
      Context.add(GitHubRoutingPermissions, makeBrowserGitHubRoutingPermissions()),
      Context.add(Persistence.EnvironmentCacheStore, NO_CACHE),
    );
  }),
);
