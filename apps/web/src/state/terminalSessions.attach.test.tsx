import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@lecturn/contracts";
import {
  EMPTY_TERMINAL_BUFFER_STATE,
  type TerminalBufferState,
} from "@lecturn/client-runtime/state/terminal";

const query = vi.hoisted(() => ({
  attach: { data: null as unknown, error: null as string | null },
}));
vi.mock("./terminal", () => ({
  terminalEnvironment: { attach: () => "attach", metadata: () => "metadata" },
}));
vi.mock("./session", () => ({ useEnvironmentScope: () => true }));
vi.mock("./query", () => ({
  useEnvironmentQuery: (kind: string) =>
    kind === "attach" ? query.attach : { data: null, error: null },
}));
import { useAttachedTerminalSession } from "./terminalSessions";

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(async () => renderer?.unmount());
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const status = () => renderer.root.findByType("output").children.join("");
  await act(async () => {
    renderer = create(<Fixture />);
  });
  expect(status()).toBe("starting");
  const update = async (state: TerminalBufferState | null, error: string | null = null) => {
    query.attach = { data: state, error };
    await act(async () => renderer.update(<Fixture />));
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
