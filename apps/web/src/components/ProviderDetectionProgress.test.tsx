import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@lecturn/contracts";
import type { ComponentProps } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: string;
    label: string;
    connection: { phase: string };
    serverConfig?: { providers: ServerProvider[] };
  }>,
}));
const refresh = vi.hoisted(() => vi.fn(async () => ({ _tag: "Success" })));
vi.mock("../state/environments", () => ({ useEnvironments: () => state }));
vi.mock("../state/server", () => ({ serverEnvironment: { refreshProviders: {} } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => refresh }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: ComponentProps<"a">) => <a>{children}</a>,
}));
vi.mock("./ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("./ui/gold-thread-spinner", () => ({ GoldThreadSpinner: () => <span /> }));
import { ProviderDetectionProgress } from "./ProviderDetectionProgress";

const failed: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-10-11T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  discovery: { status: "error", phase: "provider" },
};
let renderer: ReactTestRenderer;
function environment(id: string, provider = failed, phase = "connected") {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: { phase },
    serverConfig: { providers: [provider] },
  };
}
async function render() {
  await act(async () => {
    renderer.update(<ProviderDetectionProgress />);
  });
}
const dismissButtons = () =>
  renderer.root
    .findAllByProps({ "aria-label": "Dismiss provider notification" })
    .filter((node) => node.type === "button");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.environments = [environment("phone")];
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("provider detection notifications", () => {
  it("keeps dismissal through repeated detection and reconnect, then re-arms after recovery", async () => {
    await act(async () => {
      renderer = create(<ProviderDetectionProgress />);
    });
    expect(dismissButtons()).toHaveLength(1);
    await act(async () => dismissButtons()[0]!.props.onClick());
    expect(renderer.toJSON()).toBeNull();
    state.environments = [
      environment("phone", { ...failed, discovery: { status: "detecting", phase: "provider" } }),
    ];
    await render();
    expect(renderer.toJSON()).toBeNull();
    state.environments = [
      { environmentId: "phone", label: "phone", connection: { phase: "reconnecting" } },
    ];
    await render();
    state.environments = [
      environment("phone", { ...failed, discovery: { status: "timed-out", phase: "provider" } }),
    ];
    await render();
    expect(renderer.toJSON()).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    state.environments = [
      environment("phone", {
        ...failed,
        status: "ready",
        discovery: { status: "ready", phase: "provider" },
      }),
    ];
    await render();
    state.environments = [environment("phone")];
    await render();
    expect(dismissButtons()).toHaveLength(1);
  });

  it("dismisses the shared shell probe without replacing it with another provider's copy", async () => {
    const shell = { ...failed, discovery: { status: "detecting", phase: "shell" } } as const;
    state.environments = [
      {
        ...environment("phone"),
        serverConfig: {
          providers: [shell, { ...shell, instanceId: ProviderInstanceId.make("codex") }],
        },
      },
    ];
    await act(async () => {
      renderer = create(<ProviderDetectionProgress />);
    });
    expect(dismissButtons()).toHaveLength(1);
    await act(async () => dismissButtons()[0]!.props.onClick());
    expect(renderer.toJSON()).toBeNull();
  });

  it("isolates dismissal by environment and preserves recovery for the other provider", async () => {
    state.environments = [environment("phone"), environment("laptop")];
    await act(async () => {
      renderer = create(<ProviderDetectionProgress />);
    });
    await act(async () => dismissButtons()[0]!.props.onClick());
    expect(dismissButtons()).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).toContain("laptop");
    const retry = renderer.root
      .findAllByType("button")
      .find((node) => node.children.join("") === "Retry")!;
    await act(async () => retry.props.onClick());
    expect(refresh).toHaveBeenCalledWith({
      environmentId: "laptop",
      input: { instanceId: "claudeAgent" },
    });
    expect(dismissButtons()).toHaveLength(1);
  });
});
