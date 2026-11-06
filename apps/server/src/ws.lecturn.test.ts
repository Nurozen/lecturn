import { assert, it } from "@effect/vitest";
import {
  ExternalSessionImportError,
  ProviderInstanceId,
  type ServerConfig,
} from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { LecturnHookRejectedError } from "./orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import {
  findHookRejectionReason,
  findThreadImportFailure,
  resolveConfigDiscoveries,
  withLateEditorConfig,
} from "./ws.ts";

it("finds the import failure reason through rejected-command and Cause wrappers", () => {
  const importError = new ExternalSessionImportError({
    providerInstanceId: ProviderInstanceId.make("codex"),
    sessionId: "session-1",
    reason: "empty-session",
  });
  const wrapped = { _tag: "OrchestratorCommandRejectedError", cause: importError };
  assert.equal(findThreadImportFailure(wrapped), "empty-session");
  assert.equal(findThreadImportFailure(Cause.fail(wrapped)), "empty-session");
  assert.equal(findThreadImportFailure(Cause.die(new Error("boom"))), undefined);
});

it("surfaces a Lecturn hook refusal from a launch failure", () => {
  const refusal = new LecturnHookRejectedError({
    hook: "beforeWorktreeProvision",
    contribution: "stave",
    reason: "Stave owns this space.",
  });
  assert.equal(
    findHookRejectionReason({ _tag: "ThreadLaunchError", cause: Cause.fail(refusal) }),
    "Stave owns this space.",
  );
  assert.equal(findHookRejectionReason({ _tag: "ThreadLaunchError" }), undefined);
});

it.effect("bounds all stalled config discoveries by one shared timeout", () =>
  Effect.gen(function* () {
    const resolving = yield* resolveConfigDiscoveries({
      availableEditors: Effect.never,
      fileManagerRevealKind: Effect.never,
      remoteOpenTargets: Effect.never,
    }).pipe(Effect.forkChild);
    // Serial timeouts would need 15 s; side by side they finish at the first deadline.
    yield* TestClock.adjust(Duration.seconds(5));
    const discovered = yield* Fiber.join(resolving);
    assert.deepEqual(discovered, {
      availableEditors: [],
      fileManagerRevealKind: undefined,
      remoteOpenTargets: [],
    });
  }),
);

it.effect("re-sends the config snapshot when a switch change alters the descriptor", () =>
  Effect.gen(function* () {
    const off = { capabilities: { squireLiveSwitch: true } } as ServerConfig["environment"];
    const on = {
      capabilities: { squire: true, squireLiveSwitch: true },
    } as ServerConfig["environment"];
    const config = { availableEditors: [], environment: off } as unknown as ServerConfig;
    const events = yield* withLateEditorConfig(
      config,
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed([]),
        resolveFileManagerRevealKind: () => Effect.succeed(undefined),
      },
      // The switch replays its value on subscribe, then each change.
      Stream.make(off, on, on),
    ).pipe(Stream.runCollect);
    assert.deepEqual(
      events.map((event) => event.type),
      ["snapshot"],
    );
    const [snapshot] = events;
    assert.deepEqual(snapshot?.type === "snapshot" ? snapshot.config.environment : null, on);
  }),
);
