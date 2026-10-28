import type { AppId, AppStatus, AppStatusStreamEvent } from "@lecturn/contracts";
import {
  type AppToolPresentationApp,
  setRegisteredAppToolPresentations,
} from "@lecturn/shared/appToolPresentation";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** The app's cached tool definitions changed, so its tool titles may have. */
export interface AppToolDefinitionsChanged {
  readonly type: "tools";
  readonly appId: AppId;
}

export type AppToolPresentationEvent = AppStatusStreamEvent | AppToolDefinitionsChanged;

export type AppToolTitles = (appId: AppId) => Effect.Effect<ReadonlyMap<string, string>>;

const presentationOf = (
  app: AppStatus,
  toolTitles: ReadonlyMap<string, string>,
): AppToolPresentationApp => ({
  appId: app.appId,
  name: app.name,
  toolPrefix: app.toolPrefix,
  iconDataUrl: app.iconDataUrl,
  ...(toolTitles.size === 0 ? {} : { toolTitles }),
});

const noTitles: AppToolTitles = () => Effect.succeed(new Map());

/**
 * Keeps the adapters' app tool presentation in step with the registry. Every
 * registered app counts, not only granted ones: a prefix stays reserved while
 * its record exists, and a call finishing after a revoke keeps its branding.
 */
export const syncAppToolPresentations = <E>(
  events: Stream.Stream<AppToolPresentationEvent, E>,
  toolTitles: AppToolTitles = noTitles,
) => {
  const apps = new Map<string, AppToolPresentationApp>();
  const statuses = new Map<string, AppStatus>();
  const put = (app: AppStatus) =>
    toolTitles(app.appId).pipe(
      Effect.map((titles) => {
        statuses.set(app.appId, app);
        apps.set(app.appId, presentationOf(app, titles));
      }),
    );
  return events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (event.type === "snapshot") {
          apps.clear();
          statuses.clear();
          for (const app of event.apps) yield* put(app);
        } else if (event.type === "upsert") {
          yield* put(event.app);
        } else if (event.type === "tools") {
          const app = statuses.get(event.appId);
          if (app === undefined) return;
          yield* put(app);
        } else {
          apps.delete(event.appId);
          statuses.delete(event.appId);
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
