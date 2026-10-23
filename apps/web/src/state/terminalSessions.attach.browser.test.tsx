import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@lecturn/contracts";
import {
  EMPTY_TERMINAL_BUFFER_STATE,
  type TerminalBufferState,
} from "@lecturn/client-runtime/state/terminal";

const query = vi.hoisted(() => ({
  attach: { data: null as unknown, error: null as string | null },
}));
vi.mock(import("./terminal"), async (original) => ({
  ...(await original()),
  terminalEnvironment: { attach: () => "attach", metadata: () => "metadata" } as never,
}));
vi.mock(import("./session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("./query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((kind: string) =>
    kind === "attach" ? query.attach : { data: null, error: null }) as never,
}));
import { useAttachedTerminalSession } from "./terminalSessions";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
function Fixture() {
  const state = useAttachedTerminalSession({
    environmentId: EnvironmentId.make("synthetic-phone"),
    terminal: { threadId: ThreadId.make("synthetic-auth"), terminalId: "auth", cwd: "/synthetic" },
  });
  return <output>{state.status}</output>;
}
it("does not report a live auth PTY closed while its reconnect snapshot is pending", async () => {
  const status = () => container.textContent;
  await act(async () => root.render(<Fixture />));
  expect(status()).toBe("starting");
  const update = async (state: TerminalBufferState | null, error: string | null = null) => {
    query.attach = { data: state, error };
    await act(async () => root.render(<Fixture />));
  };
  await update({ ...EMPTY_TERMINAL_BUFFER_STATE, version: 1, status: "running" });
  expect(status()).toBe("running");
  await update(null, "Synthetic disconnect");
  expect(status()).toBe("error");
  await update(EMPTY_TERMINAL_BUFFER_STATE);
  expect(status()).toBe("starting");
  await update({ ...EMPTY_TERMINAL_BUFFER_STATE, version: 1, status: "running" });
  expect(status()).toBe("running");
  await update({ ...EMPTY_TERMINAL_BUFFER_STATE, version: 2, status: "closed" });
  expect(status()).toBe("closed");
});
