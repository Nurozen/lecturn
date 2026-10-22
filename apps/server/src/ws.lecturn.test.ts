import { assert, it } from "@effect/vitest";
import { ExternalSessionImportError, ProviderInstanceId } from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { LecturnHookRejectedError } from "./orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import {
  findHookRejectionReason,
  findThreadImportFailure,
  resolveConfigDiscoveries,
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
