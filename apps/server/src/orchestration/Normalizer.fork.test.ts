import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type ClientOrchestrationCommand, CommandId, ThreadId, TurnId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as StaveAdmission from "../stave/StaveAdmission.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

const testLayer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-normalizer-fork-" }),
  StaveAdmission.layerNoop,
  Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({}),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("normalizeDispatchCommand thread.fork", () => {
  it.effect("rejects a client fork: only the WebSocket dispatcher materializes it", () =>
    Effect.gen(function* () {
      const command: ClientOrchestrationCommand = {
        type: "thread.fork",
        commandId: CommandId.make("command-fork-1"),
        threadId: ThreadId.make("thread-fork-child"),
        sourceThreadId: ThreadId.make("thread-fork-source"),
        throughTurnId: TurnId.make("turn-1"),
        workspace: "inherit",
        createdAt: "2026-05-01T00:00:00.000Z",
      };
      const error = yield* Effect.flip(normalizeDispatchCommand(command));
      expect(error._tag).toBe("OrchestrationDispatchCommandError");
      expect(error.message).toContain("WebSocket dispatcher");
    }).pipe(Effect.provide(testLayer)),
  );
});
