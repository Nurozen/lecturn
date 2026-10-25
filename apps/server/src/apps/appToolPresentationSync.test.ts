import { describe, expect, it } from "@effect/vitest";
import type { AppStatus, AppStatusStreamEvent } from "@lecturn/contracts";
import {
  registeredAppToolPresentations,
  resolveAppToolPresentation,
  setRegisteredAppToolPresentations,
} from "@lecturn/shared/appToolPresentation";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { syncAppToolPresentations } from "./appToolPresentationSync.ts";

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
});
