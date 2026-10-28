import { describe, expect, it } from "@effect/vitest";
import type { AppStatus, AppStatusStreamEvent } from "@lecturn/contracts";
import {
  registeredAppToolPresentations,
  resolveAppToolPresentation,
  setRegisteredAppToolPresentations,
} from "@lecturn/shared/appToolPresentation";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  type AppToolPresentationEvent,
  syncAppToolPresentations,
} from "./appToolPresentationSync.ts";

const status = (appId: string, name: string, toolPrefix: string) =>
  ({ appId, name, toolPrefix, iconDataUrl: "data:image/png;base64,iVBORw0KGgo=" }) as AppStatus;

describe("syncAppToolPresentations", () => {
  it.effect("tracks registry events and clears the apps when the registry stops", () =>
    Effect.gen(function* () {
      const seen: Array<ReadonlyArray<string>> = [];
      const record = Effect.sync(() =>
        seen.push(registeredAppToolPresentations().map((app) => `${app.toolPrefix}:${app.name}`)),
      );
      const events: ReadonlyArray<AppStatusStreamEvent> = [
        { type: "snapshot", apps: [status("dev.rocketwright.app", "RocketWright", "rw")] },
        { type: "upsert", app: status("dev.example.app", "Example", "ex") },
        { type: "upsert", app: status("dev.rocketwright.app", "RocketWright 2", "rw") },
        { type: "remove", appId: "dev.example.app" as AppStatus["appId"] },
        { type: "snapshot", apps: [] },
      ];
      yield* syncAppToolPresentations(Stream.fromIterable(events).pipe(Stream.tap(() => record)));

      // Each tap runs before its event applies, so seen[n] is the state after event n-1.
      expect(seen).toEqual([
        [],
        ["rw:RocketWright"],
        ["rw:RocketWright", "ex:Example"],
        ["rw:RocketWright 2", "ex:Example"],
        ["rw:RocketWright 2"],
      ]);
      expect(registeredAppToolPresentations()).toEqual([]);

      setRegisteredAppToolPresentations([status("dev.rocketwright.app", "RocketWright", "rw")]);
      yield* syncAppToolPresentations(Stream.fail("registry closed"));
      expect(resolveAppToolPresentation({ toolName: "mcp__lecturn__rw_simulate" })).toBeNull();
    }),
  );

  it.effect("names each tool by its declared title, following definition changes", () =>
    Effect.gen(function* () {
      const appId = "dev.rocketwright.app" as AppStatus["appId"];
      let declared = new Map([["motor_search", "Find motors"]]);
      const title = () =>
        resolveAppToolPresentation({ toolName: "mcp__lecturn__rw_motor_search" })?.title;
      // Each step runs before its event applies: it reads the state the previous event left.
      const steps: ReadonlyArray<readonly [AppToolPresentationEvent, () => void]> = [
        [{ type: "snapshot", apps: [status(appId, "RocketWright", "rw")] }, () => undefined],
        [{ type: "tools", appId }, () => (declared = new Map([["motor_search", "Search motors"]]))],
        [{ type: "tools", appId: "dev.other.app" as AppStatus["appId"] }, () => undefined],
        [
          { type: "upsert", app: status(appId, "RocketWright", "rw") },
          () => (declared = new Map()),
        ],
      ];
      const seen: Array<string | undefined> = [];
      yield* syncAppToolPresentations(
        Stream.fromIterable(steps).pipe(
          Stream.tap(([, before]) =>
            Effect.sync(() => {
              seen.push(title());
              before();
            }),
          ),
          Stream.map(([event]) => event),
        ),
        () => Effect.sync(() => declared),
      );

      expect(seen).toEqual([undefined, "Find motors", "Search motors", "Search motors"]);
    }),
  );
});
