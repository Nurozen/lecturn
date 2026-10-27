import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@lecturn/contracts";
import { makeProviderReplayGate } from "@lecturn/provider-testing/replayGate";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { ACP_PROTOCOL } from "@lecturn/provider-acp/server/adapter";
import {
  withAcpReplaySessionUpdateReceipts,
  type AcpReplayTranscript,
} from "./AcpAdapterV2.testkit.ts";

describe("ACP replay consumer receipts", () => {
  it.effect(
    "waits for the session update handler to finish before releasing the clock barrier",
    () =>
      Effect.gen(function* () {
        const gate = makeProviderReplayGate([]);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const notification = {
          sessionId: "session-1",
          update: { sessionUpdate: "available_commands_update", availableCommands: [] },
          _meta: { eventId: "wake-end-id" },
        } as const;
        const transcript: AcpReplayTranscript = {
          provider: ProviderDriverKind.make("grok"),
          protocol: ACP_PROTOCOL,
          version: "1",
          scenario: "delayed-wake",
          entries: [
            {
              type: "emit_inbound",
              label: "wake-end",
              frame: { kind: "notification", method: "session/update", params: notification },
            },
          ],
        };
        let processed = false;
        const receipt = gate.waitForProcessed("wake-end").then(() => {
          processed = true;
        });
        const handler = withAcpReplaySessionUpdateReceipts(transcript, gate, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const processing = yield* handler(notification).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Effect.promise(() => gate.beforeEmit("wake-end"));
        assert.isFalse(processed);

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(processing);
        yield* Effect.promise(() => receipt);
        assert.isTrue(processed);
      }),
  );
});
