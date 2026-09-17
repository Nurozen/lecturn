import { useCallback } from "react";
import {
  CommandId,
  ThreadTurnStartCommand,
  type EnvironmentId,
  type ThreadId,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { readThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { newMessageId, randomUUID } from "../../lib/utils";
import { formatEnvironmentQueryError } from "../../state/query";

type SteerCommand = typeof ThreadTurnStartCommand.Type;
type IntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const decodeIntent = Schema.decodeUnknownSync(Schema.fromJsonString(ThreadTurnStartCommand));
const encodeIntent = Schema.encodeSync(Schema.fromJsonString(ThreadTurnStartCommand));
const inFlight = new Map<string, { text: string; promise: Promise<void> }>();

/** Keep the complete command until a receipt arrives, including across app reloads. */
export function sendQuickSteerIntent(input: {
  storage: IntentStorage;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  text: string;
  createCommand: () => SteerCommand;
  send: (command: SteerCommand) => Promise<void>;
}): Promise<void> {
  const key = `lecturn:quick-steer:v1:${JSON.stringify([input.environmentId, input.threadId])}`;
  const active = inFlight.get(key);
  if (active)
    return active.text === input.text
      ? active.promise
      : Promise.reject(
          new Error(
            "The previous steering message is still being confirmed. Your edited draft has not been sent.",
          ),
        );
  const promise = Promise.resolve()
    .then(async () => {
      const saved = input.storage.getItem(key);
      const command = saved === null ? input.createCommand() : decodeIntent(saved);
      if (command.threadId !== input.threadId)
        throw new Error(
          "The saved steering message targets a different thread. It has not been sent.",
        );
      if (command.message.text !== input.text) {
        throw new Error(
          "The previous steering message is still unconfirmed. Retry its original text to confirm it before sending an edited draft. Neither message was sent by this attempt.",
        );
      }
      // Persist before touching the connection. A blocked/full store must not turn an ambiguous
      // websocket failure into a fresh command after a reload.
      if (saved === null) input.storage.setItem(key, encodeIntent(command));
      await input.send(command);
      input.storage.removeItem(key);
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, { text: input.text, promise });
  return promise;
}

/** A distinct message leaves the chat composer's unsent draft intact. */
export function useQuickSteer() {
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  return useCallback(
    async (environmentId: EnvironmentId, threadId: ThreadId, text: string) => {
      if (!text.trim()) throw new Error("Enter a steering message.");
      if (text.length > 8000) throw new Error("Steering messages are limited to 8,000 characters.");
      await sendQuickSteerIntent({
        storage: window.localStorage,
        environmentId,
        threadId,
        text,
        createCommand: () => {
          const thread = readThreadShell({ environmentId, threadId });
          if (!thread || thread.archivedAt)
            throw new Error("The managing thread is no longer available.");
          return {
            type: "thread.turn.start",
            commandId: CommandId.make(randomUUID()),
            threadId,
            message: { messageId: newMessageId(), role: "user", text, attachments: [] },
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt: new Date().toISOString(),
          };
        },
        send: async (command) => {
          const result = await start({ environmentId, input: command });
          if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
        },
      });
    },
    [start],
  );
}
