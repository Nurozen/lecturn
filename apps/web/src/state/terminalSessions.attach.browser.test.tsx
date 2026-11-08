import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@lecturn/contracts";
import {
  EMPTY_TERMINAL_BUFFER_STATE,
  type TerminalBufferState,
} from "@lecturn/client-runtime/state/terminal";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";

const attach = vi.hoisted(() => ({ atom: null as unknown }));
vi.mock("./terminal", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const attachAtom = Atom.make(AsyncResult.initial(true));
  attach.atom = attachAtom;
  return {
    terminalEnvironment: {
      attach: () => attachAtom,
      metadata: () => Atom.make(AsyncResult.initial(true)),
    },
  };
});
vi.mock("./session", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const granted = Atom.make(AsyncResult.success({}));
  return {
    environmentSession: { sessionStateAtom: () => granted },
    sessionHasScope: () => true,
    useEnvironmentScope: () => true,
  };
});

import { attachedTerminalSessionAtom } from "./terminalSessions";

it("does not report a live auth PTY closed while its reconnect snapshot is pending", () => {
  const registry = AtomRegistry.make();
  const session = attachedTerminalSessionAtom(EnvironmentId.make("synthetic-phone"), {
    threadId: ThreadId.make("synthetic-auth"),
    terminalId: "auth",
    cwd: "/synthetic",
  });
  const unmount = registry.mount(session);
  const attachAtom = attach.atom as Atom.Writable<
    AsyncResult.AsyncResult<TerminalBufferState, string>
  >;
  const status = () => registry.get(session).status;
  const update = (state: TerminalBufferState | null) =>
    registry.set(
      attachAtom,
      state === null
        ? AsyncResult.failure(Cause.fail("Synthetic disconnect"))
        : AsyncResult.success(state),
    );
  expect(status()).toBe("starting");
  update({ ...EMPTY_TERMINAL_BUFFER_STATE, version: 1, status: "running" });
  expect(status()).toBe("running");
  update(null);
  expect(status()).toBe("error");
  update(EMPTY_TERMINAL_BUFFER_STATE);
  expect(status()).toBe("starting");
  update({ ...EMPTY_TERMINAL_BUFFER_STATE, version: 1, status: "running" });
  expect(status()).toBe("running");
  update({ ...EMPTY_TERMINAL_BUFFER_STATE, version: 2, status: "closed" });
  expect(status()).toBe("closed");
  unmount();
});
