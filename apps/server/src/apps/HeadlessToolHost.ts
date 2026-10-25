/**
 * Stub until A15: operations that need the real service fail with
 * `AppsNotImplemented`. The process table is the shared AppRuntimeState one,
 * so the onRunTerminal reaper contribution sees the processes this host runs.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { AppRuntimeState } from "./AppRuntimeState.ts";
import { HeadlessToolHost, AppsNotImplemented } from "./services.ts";

const notImplemented = (method: string) =>
  new AppsNotImplemented({ service: "HeadlessToolHost", method });

export const layer = Layer.effect(
  HeadlessToolHost,
  Effect.gen(function* () {
    const { headlessProcesses } = yield* AppRuntimeState;
    return HeadlessToolHost.of({
      acquire: () => Effect.fail(notImplemented("acquire")),
      listTools: () => Effect.fail(notImplemented("listTools")),
      call: () => Effect.fail(notImplemented("call")),
      refreshDefinitions: () => Effect.fail(notImplemented("refreshDefinitions")),
      listForEmptyCache: () => Effect.fail(notImplemented("listForEmptyCache")),
      stopApp: (appId) =>
        Ref.modify(headlessProcesses, (entries) => {
          const stopped = [...entries.values()].filter((entry) => entry.appId === appId);
          const next = new Map(entries);
          for (const [key, entry] of entries) if (entry.appId === appId) next.delete(key);
          return [stopped, next];
        }).pipe(
          Effect.flatMap((stopped) =>
            Effect.forEach(stopped, (entry) => entry.kill, { discard: true }),
          ),
        ),
    });
  }),
);
