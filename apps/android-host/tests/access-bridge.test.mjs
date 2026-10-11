import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

const script = readFileSync(
  new URL("../app/src/main/assets/android-host-access.js", import.meta.url),
  "utf8",
);
function harness(frame = false) {
  const messages = [],
    timers = new Map(),
    events = new Map();
  let next = 0;
  const window = {
    __lecturnNative: { postMessage: (data) => messages.push(JSON.parse(data)) },
    addEventListener: (name, listener) => events.set(name, listener),
  };
  window.top = frame ? {} : window;
  runInNewContext(script, {
    window,
    setTimeout: (callback) => {
      timers.set(++next, callback);
      return next;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  return {
    window,
    messages,
    timers,
    events,
    host: window.symbaHost,
    reply: (id, state, version = 2) =>
      window.__lecturnNative.onmessage({
        data: JSON.stringify({ protocolVersion: version, requestId: id, state }),
      }),
  };
}
const granted = {
  verified: true,
  fullAccess: true,
  computerUse: false,
  revision: 3,
  capabilities: { appData: true, computerUse: false },
};

test("only main frame receives the narrow frozen promise API", () => {
  assert.equal(harness(true).host, undefined);
  const h = harness();
  assert.equal(Object.isFrozen(h.host), true);
  assert.deepEqual(Object.keys(h.host).sort(), [
    "getAccessState",
    "openDeviceAccess",
    "protocolVersion",
    "requestFullAccess",
  ]);
  assert.equal(h.messages.length, 0); // Page initialization cannot request or grant access.
});
test("only the matching v2 acknowledgement resolves each pending request", async () => {
  const h = harness();
  let finished = false;
  const full = h.host.requestFullAccess("thread").then((state) => {
    finished = true;
    return state;
  });
  const read = h.host.getAccessState();
  assert.equal(h.messages[0].threadId, "thread");
  h.reply("unknown", granted);
  h.reply(h.messages[0].requestId, granted, 1);
  await Promise.resolve();
  assert.equal(finished, false);
  h.reply(h.messages[1].requestId, { ...granted, fullAccess: false });
  assert.equal((await read).fullAccess, false);
  assert.equal(finished, false);
  h.reply(h.messages[0].requestId, granted);
  assert.equal((await full).fullAccess, true);
  assert.equal(h.timers.size, 0);
});
test("page departure drains all promises false and late receipts are ignored", async () => {
  const h = harness();
  const first = h.host.requestFullAccess("thread"),
    second = h.host.openDeviceAccess();
  h.events.get("pagehide")();
  h.reply(h.messages[0].requestId, granted);
  for (const state of await Promise.all([first, second])) {
    assert.equal(state.fullAccess, false);
    assert.equal(state.verified, false);
  }
  assert.equal(h.timers.size, 0);
});
test("pending requests are bounded and time out false", async () => {
  const h = harness();
  const pending = Array.from({ length: 16 }, () => h.host.getAccessState());
  assert.equal((await h.host.requestFullAccess("overflow")).verified, false);
  assert.equal(h.messages.length, 16);
  for (const timeout of Array.from(h.timers.values())) timeout();
  assert.equal(h.timers.size, 0);
  assert.equal(
    (await Promise.all(pending)).every((s) => s.fullAccess === false),
    true,
  );
});
test("invalid thread and broken transport settle false without hanging", async () => {
  const h = harness();
  for (const thread of [undefined, "", " ", "a".repeat(257)])
    assert.equal((await h.host.requestFullAccess(thread)).fullAccess, false);
  assert.equal(h.messages.length, 0);
  h.window.__lecturnNative.postMessage = () => {
    throw new Error("disconnected");
  };
  assert.equal((await h.host.requestFullAccess("thread")).verified, false);
  assert.equal(h.timers.size, 0);
});
