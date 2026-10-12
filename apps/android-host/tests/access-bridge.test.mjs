import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";

const script = NodeFS.readFileSync(
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
  NodeVM.runInNewContext(script, {
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

NodeTest.test("only main frame receives the narrow frozen promise API", () => {
  NodeAssert.equal(harness(true).host, undefined);
  const h = harness();
  NodeAssert.equal(Object.isFrozen(h.host), true);
  NodeAssert.deepEqual(Object.keys(h.host).sort(), [
    "connectAccount",
    "getAccessState",
    "getConnectState",
    "getConnectToken",
    "nativeConnect",
    "openConnectSignIn",
    "openDeviceAccess",
    "protocolVersion",
    "publishChatWidget",
    "requestFullAccess",
    "signOutConnect",
  ]);
  NodeAssert.equal(h.host.connectAccount, true);
  NodeAssert.equal(h.host.nativeConnect, true);
  NodeAssert.equal(h.messages.length, 0); // Page initialization cannot request or grant access.
});
NodeTest.test("only the matching v2 acknowledgement resolves each pending request", async () => {
  const h = harness();
  let finished = false;
  const full = h.host.requestFullAccess("thread").then((state) => {
    finished = true;
    return state;
  });
  const read = h.host.getAccessState();
  NodeAssert.equal(h.messages[0].threadId, "thread");
  h.reply("unknown", granted);
  h.reply(h.messages[0].requestId, granted, 1);
  await Promise.resolve();
  NodeAssert.equal(finished, false);
  h.reply(h.messages[1].requestId, { ...granted, fullAccess: false });
  NodeAssert.equal((await read).fullAccess, false);
  NodeAssert.equal(finished, false);
  h.reply(h.messages[0].requestId, granted);
  NodeAssert.equal((await full).fullAccess, true);
  NodeAssert.equal(h.timers.size, 0);
});
NodeTest.test(
  "page departure drains all promises false and late receipts are ignored",
  async () => {
    const h = harness();
    const first = h.host.requestFullAccess("thread"),
      second = h.host.openDeviceAccess();
    h.events.get("pagehide")();
    h.reply(h.messages[0].requestId, granted);
    for (const state of await Promise.all([first, second])) {
      NodeAssert.equal(state.fullAccess, false);
      NodeAssert.equal(state.verified, false);
    }
    NodeAssert.equal(h.timers.size, 0);
  },
);
NodeTest.test("pending requests are bounded and time out false", async () => {
  const h = harness();
  const pending = Array.from({ length: 16 }, () => h.host.getAccessState());
  NodeAssert.equal((await h.host.requestFullAccess("overflow")).verified, false);
  NodeAssert.equal(h.messages.length, 16);
  for (const timeout of Array.from(h.timers.values())) timeout();
  NodeAssert.equal(h.timers.size, 0);
  NodeAssert.equal(
    (await Promise.all(pending)).every((s) => s.fullAccess === false),
    true,
  );
});
NodeTest.test("invalid thread and broken transport settle false without hanging", async () => {
  const h = harness();
  for (const thread of [undefined, "", " ", "a".repeat(257)])
    NodeAssert.equal((await h.host.requestFullAccess(thread)).fullAccess, false);
  NodeAssert.equal(h.messages.length, 0);
  h.window.__lecturnNative.postMessage = () => {
    throw new Error("disconnected");
  };
  NodeAssert.equal((await h.host.requestFullAccess("thread")).verified, false);
  NodeAssert.equal(h.timers.size, 0);
});

NodeTest.test(
  "widget publication is an explicit correlated request, never a grant or send",
  async () => {
    const h = harness();
    const payload = {
      threadId: "demo",
      title: "Demo",
      messages: [{ role: "assistant", text: "Hello" }],
    };
    const pending = h.host.publishChatWidget(payload);
    NodeAssert.equal(h.messages[0].method, "publishChatWidget");
    NodeAssert.deepEqual(h.messages[0].payload, payload);
    h.reply(h.messages[0].requestId, { published: true });
    NodeAssert.equal((await pending).published, true);
    NodeAssert.equal(h.messages.length, 1);
  },
);

NodeTest.test(
  "failed widget publication reports false without an access-shaped result",
  async () => {
    const h = harness();
    const pending = h.host.publishChatWidget(null);
    for (const timeout of Array.from(h.timers.values())) timeout();
    const response = await pending;
    NodeAssert.equal(response.published, false);
    NodeAssert.deepEqual(Object.keys(response), ["published"]);
  },
);

NodeTest.test(
  "native auth uses the fixed method names and token payload with correlated replies",
  async () => {
    const h = harness();
    const opening = h.host.openConnectSignIn();
    const status = h.host.getConnectState();
    const token = h.host.getConnectToken("account-one");
    NodeAssert.deepEqual(
      h.messages.map((m) => m.method),
      ["openConnectSignIn", "getConnectState", "getConnectToken"],
    );
    NodeAssert.deepEqual(h.messages[2].payload, { accountId: "account-one" });
    NodeAssert.equal(h.messages[2].threadId, undefined);
    h.reply(h.messages[2].requestId, { token: "synthetic.session.jwt" });
    NodeAssert.equal((await token).token, "synthetic.session.jwt");
    h.reply(h.messages[0].requestId, {
      configured: true,
      state: "authorizing",
      account: null,
      relayUrl: "https://relay.test",
    });
    NodeAssert.equal((await opening).state, "authorizing");
    NodeAssert.equal(h.timers.size, 1); // No login timer remains after the opening receipt.
    h.reply(h.messages[1].requestId, {
      configured: true,
      state: "signed-out",
      account: null,
      relayUrl: "https://relay.test",
    });
    NodeAssert.equal((await status).state, "signed-out");
    const logout = h.host.signOutConnect();
    NodeAssert.equal(h.messages[3].method, "signOutConnect");
    h.reply(h.messages[3].requestId, { state: "signed-out" });
    NodeAssert.equal((await logout).state, "signed-out");
    NodeAssert.equal(h.timers.size, 0);
  },
);

NodeTest.test(
  "auth shares the bounded queue and invalid account requests never reach native",
  async () => {
    const h = harness();
    for (const id of [undefined, "", " ", "a".repeat(513)]) {
      NodeAssert.equal((await h.host.getConnectToken(id)).verified, false);
    }
    NodeAssert.equal(h.messages.length, 0);
    const pending = Array.from({ length: 16 }, () => h.host.getConnectState());
    NodeAssert.equal((await h.host.openConnectSignIn()).verified, false);
    NodeAssert.equal(h.messages.length, 16);
    h.events.get("pagehide")();
    h.reply(h.messages[0].requestId, { state: "signed-in" });
    NodeAssert.equal(
      (await Promise.all(pending)).every((s) => s.verified === false),
      true,
    );
    NodeAssert.equal(h.timers.size, 0);
  },
);
