import { describe, expect, it, vi } from "vite-plus/test";
import {
  createLocalThreadActivityIntentStore,
  localThreadActivityKey,
} from "./localThreadActivityIntent";
const prefix = "environment-data:commands:thread:";
const target = {
  environmentId: "local",
  input: { threadId: "one", message: { text: "private draft" } },
};
describe("local thread activity intents", () => {
  it("records scoped metadata before observation without retaining command payloads", () => {
    const store = createLocalThreadActivityIntentStore(
      () => "intent",
      () => 123,
    );
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.begin(`${prefix}start-turn`, target);
    expect(store.getSnapshot().get(localThreadActivityKey("local", "one"))).toEqual({
      id: "intent",
      kind: "start",
      at: 123,
    });
    expect(JSON.stringify([...store.getSnapshot().values()])).not.toContain("private draft");
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    store.begin(`${prefix}settle`, target);
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it("ignores unrelated commands and malformed inputs", () => {
    const store = createLocalThreadActivityIntentStore();
    expect(store.begin(`${prefix}update-metadata`, target)).toBeNull();
    expect(store.begin(`${prefix}start-turn`, { input: target.input })).toBeNull();
    expect(store.begin(undefined, target)).toBeNull();
    expect(store.getSnapshot().size).toBe(0);
  });
  it("does not erase a newer action when an older command fails", () => {
    let sequence = 0;
    const store = createLocalThreadActivityIntentStore(
      () => String(++sequence),
      () => 123,
    );
    const first = store.begin(`${prefix}start-turn`, target);
    const second = store.begin(`${prefix}interrupt-turn`, target);
    store.cancel(first);
    expect([...store.getSnapshot().values()]).toEqual([{ id: "2", kind: "stop", at: 123 }]);
    store.cancel(second);
    expect(store.getSnapshot().size).toBe(0);
  });
  it("keeps environments independent and bounds history to the latest 200 targets", () => {
    let sequence = 0;
    const store = createLocalThreadActivityIntentStore(
      () => String(++sequence),
      () => 123,
    );
    store.begin(`${prefix}settle`, target);
    store.begin(`${prefix}unsettle`, { ...target, environmentId: "remote" });
    expect(store.getSnapshot().size).toBe(2);
    for (let index = 0; index < 200; index++)
      store.begin(`${prefix}stop-session`, {
        environmentId: "local",
        input: { threadId: String(index) },
      });
    expect(store.getSnapshot().size).toBe(200);
    expect(store.getSnapshot().has(localThreadActivityKey("local", "one"))).toBe(false);
    expect(store.getSnapshot().has(localThreadActivityKey("local", "199"))).toBe(true);
  });
});
