import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ThreadTurnStartCommand,
} from "@lecturn/contracts";
import { sendQuickSteerIntent } from "./useQuickSteer";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
function command(text = "Please check CI", id = "original"): typeof ThreadTurnStartCommand.Type {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make(id),
    threadId: ThreadId.make("thread"),
    message: { messageId: MessageId.make(id), role: "user", text, attachments: [] },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-09-13T00:00:00Z",
  };
}
const target = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

describe("durable quick steering", () => {
  it("reuses the entire persisted command after an ambiguous dispatch failure", async () => {
    const store = storage();
    const accepted: Array<typeof ThreadTurnStartCommand.Type> = [];
    await expect(
      sendQuickSteerIntent({
        ...target,
        storage: store,
        text: "Please check CI",
        createCommand: () => command(),
        send: async (input) => {
          accepted.push(input);
          throw new Error("connection lost after persistence");
        },
      }),
    ).rejects.toThrow("connection lost");
    expect(store.values.size).toBe(1);
    await sendQuickSteerIntent({
      ...target,
      storage: store,
      text: "Please check CI",
      createCommand: () => command("Please check CI", "different-id"),
      send: async (input) => {
        accepted.push(input);
      },
    });
    expect(accepted[1]).toEqual(accepted[0]);
    expect(store.values.size).toBe(0);
  });
  it("refuses edited text without dispatching or discarding the unconfirmed original", async () => {
    const store = storage();
    const sent: string[] = [];
    const send = async (input: typeof ThreadTurnStartCommand.Type) => {
      sent.push(input.message.text);
    };
    await expect(
      sendQuickSteerIntent({
        ...target,
        storage: store,
        text: "Please check CI",
        createCommand: () => command(),
        send: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow();
    const pending = [...store.values.entries()];
    await expect(
      sendQuickSteerIntent({
        ...target,
        storage: store,
        text: "Changed request",
        createCommand: () => command("Changed request", "new"),
        send,
      }),
    ).rejects.toThrow("Retry its original text to confirm it");
    expect(sent).toEqual([]);
    expect([...store.values.entries()]).toEqual(pending);
    await sendQuickSteerIntent({
      ...target,
      storage: store,
      text: "Please check CI",
      createCommand: () => command("Please check CI", "replacement-id"),
      send: async (input) => {
        expect(input.commandId).toBe("original");
        await send(input);
      },
    });
    expect(store.values.size).toBe(0);
    await sendQuickSteerIntent({
      ...target,
      storage: store,
      text: "Changed request",
      createCommand: () => command("Changed request", "new"),
      send,
    });
    expect(sent).toEqual(["Please check CI", "Changed request"]);
  });
  it("never dispatches an unpersisted command and isolates environments", async () => {
    let sent = 0;
    const store = storage();
    await expect(
      sendQuickSteerIntent({
        ...target,
        storage: {
          ...store,
          setItem: () => {
            throw new Error("full");
          },
        },
        text: "Please check CI",
        createCommand: () => command(),
        send: async () => {
          sent++;
        },
      }),
    ).rejects.toThrow("full");
    expect(sent).toBe(0);
    await expect(
      sendQuickSteerIntent({
        ...target,
        storage: store,
        text: "Please check CI",
        createCommand: () => command(),
        send: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow();
    await sendQuickSteerIntent({
      ...target,
      environmentId: EnvironmentId.make("other"),
      storage: store,
      text: "Please check CI",
      createCommand: () => command("Please check CI", "other"),
      send: async (input) => {
        expect(input.commandId).toBe("other");
      },
    });
    expect(store.values.size).toBe(1);
  });
  it("shares the outstanding receipt for concurrent retries", async () => {
    const store = storage();
    let release!: () => void;
    const receipt = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const input = {
      ...target,
      storage: store,
      text: "Please check CI",
      createCommand: () => command(),
      send: async () => {
        sends++;
        await receipt;
      },
    };
    const first = sendQuickSteerIntent(input);
    const second = sendQuickSteerIntent(input);
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    expect(sends).toBe(1);
  });
});
