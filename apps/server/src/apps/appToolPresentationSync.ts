import type { AppStatus, AppStatusStreamEvent } from "@lecturn/contracts";
import {
  type AppToolPresentationApp,
  setRegisteredAppToolPresentations,
} from "@lecturn/shared/appToolPresentation";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const presentationOf = (app: AppStatus): AppToolPresentationApp => ({
  appId: app.appId,
  name: app.name,
  toolPrefix: app.toolPrefix,
  iconDataUrl: app.iconDataUrl,
});

/**
 * Keeps the adapters' app tool presentation in step with the registry. Every
 * registered app counts, not only granted ones: a prefix stays reserved while
 * its record exists, and a call finishing after a revoke keeps its branding.
 */
export const syncAppToolPresentations = <E>(statuses: Stream.Stream<AppStatusStreamEvent, E>) => {
  const apps = new Map<string, AppToolPresentationApp>();
  return statuses.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          apps.clear();
          for (const app of event.apps) apps.set(app.appId, presentationOf(app));
        } else if (event.type === "upsert") {
          apps.set(event.app.appId, presentationOf(event.app));
        } else {
          apps.delete(event.appId);
        }
        setRegisteredAppToolPresentations(apps.values());
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Connected-app tool rows stopped following the registry", { cause }),
    ),
    Effect.ensuring(Effect.sync(() => setRegisteredAppToolPresentations([]))),
  );
};
