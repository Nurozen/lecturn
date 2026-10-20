import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, USAGE_CONTRACT_VERSION, type UsageSummary } from "@lecturn/contracts";
import { makeWindow } from "@lecturn/shared/usageFormat";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const ui = vi.hoisted(() => ({
  text: [] as string[],
  refresh: undefined as (() => void) | undefined,
  press: new Map<string, () => void>(),
  selectEnvironment: undefined as ((event: { nativeEvent: { event: string } }) => void) | undefined,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children: ReactNode }) => children,
  ScrollView: ({
    children,
    refreshControl,
  }: {
    children: ReactNode;
    refreshControl: ReactNode;
  }) => (
    <>
      {refreshControl}
      {children}
    </>
  ),
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) => {
    if (accessibilityLabel && onPress) ui.press.set(accessibilityLabel, onPress);
    return children;
  },
  RefreshControl: ({ onRefresh }: { onRefresh: () => void }) => {
    ui.refresh = onRefresh;
    return null;
  },
}));
vi.mock("react-native-reanimated", () => {
  const transition = {
    duration: () => transition,
    reduceMotion: () => transition,
    easing: () => transition,
  };
  return {
    default: { View: ({ children }: { children: ReactNode }) => children },
    FadeIn: transition,
    LinearTransition: transition,
    ReduceMotion: { System: "system" },
    Easing: { cubic: () => 0, out: () => undefined },
  };
});
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ setOptions() {}, goBack() {} }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ArcaneBackdrop", () => ({
  ArcaneBackdrop: () => {
    ui.text = [];
    return null;
  },
}));
vi.mock("../../components/GlassCard", () => ({
  GlassCard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => {
    ui.text.push([children].flat().join(""));
    return null;
  },
}));
vi.mock("../../components/AndroidScreenHeader", () => ({
  AndroidScreenHeader: ({ trailing }: { trailing: ReactNode }) => trailing,
}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ControlPill", () => ({
  ControlPillMenu: ({
    children,
    onPressAction,
  }: {
    children: ReactNode;
    onPressAction: typeof ui.selectEnvironment;
  }) => {
    ui.selectEnvironment = onPressAction;
    return children;
  },
}));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./UsageDailyChart", () => ({ UsageDailyChart: () => null }));
vi.mock("./UsageLimitsSection", () => ({
  useRefreshLimits: () => ({
    now: 0,
    failedLabels: [],
    refreshing: false,
    refresh: async () => {},
  }),
}));
vi.mock("./UsageLimitsPooled", () => ({ UsageLimitsSection: () => null }));
vi.mock("./usageProviders", () => ({
  PROVIDER_LABEL: { codex: "Codex" },
  useProviderColors: () => ({ codex: "#ffffff" }),
}));

const backend = vi.hoisted(() => ({
  getRegistry: undefined as (() => AtomRegistry.AtomRegistry) | undefined,
  getPresentations: undefined as (() => unknown) | undefined,
  getPresentation: undefined as ((id: EnvironmentId) => unknown) | undefined,
  getQuery: undefined as ((id: EnvironmentId) => unknown) | undefined,
}));
vi.mock("../../state/atom-registry", () => ({
  get appAtomRegistry() {
    return backend.getRegistry!();
  },
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: {
    get presentationsAtom() {
      return backend.getPresentations!();
    },
    presentationAtom: (id: EnvironmentId) => backend.getPresentation!(id),
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    usageSummary: ({ environmentId }: { environmentId: EnvironmentId }) =>
      backend.getQuery!(environmentId),
    refreshUsageRates: { label: "test refresh rates", run: async () => AsyncResult.success({}) },
  },
}));

import { UsageRouteScreen } from "./UsageRouteScreen";

let root: Root;
let registry: AtomRegistry.AtomRegistry;
const outcomes = new Map<EnvironmentId, Effect.Effect<UsageSummary, Error>>();
const connected = { connection: { phase: "connected" }, entry: { target: { label: "" } } };
const presentations = Atom.make(new Map<EnvironmentId, typeof connected>());
const presentation = Atom.family((id: EnvironmentId) =>
  Atom.make((get) => get(presentations).get(id)),
);
const queries = Atom.family((id: EnvironmentId) =>
  Atom.make(Effect.suspend(() => outcomes.get(id)!)),
);
const healthy = EnvironmentId.make("healthy");
const unavailable = EnvironmentId.make("unavailable");

function summary(contractVersion: number = USAGE_CONTRACT_VERSION): UsageSummary {
  const window = makeWindow(30);
  return {
    ...window,
    contractVersion,
    readAt: new Date().toISOString(),
    buckets: [
      {
        day: window.untilDay,
        provider: "codex",
        model: "test-model",
        totals: {
          uncachedInputTokens: 1000,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 100,
          reasoningTokens: 0,
        },
        costUsd: 12.5,
        cacheSavingsUsd: 0,
        costSource: "modelPriced",
        records: 1,
        unpricedRecords: 0,
        sessions: 1,
      },
    ],
    sources: [
      {
        fingerprint: {
          hostId: "fixture",
          provider: "codex",
          resolvedHomePath: "/fixture/codex",
          volumeId: "fixture-volume",
        },
        status: "ok",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
      },
    ],
    pricing: { status: "fresh", source: "fixture", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
  };
}

function addEnvironment(
  id: EnvironmentId,
  label: string,
  result: Effect.Effect<UsageSummary, Error>,
) {
  outcomes.set(id, result);
  registry.set(
    presentations,
    new Map(registry.get(presentations)).set(id, {
      connection: { phase: "connected" },
      entry: { target: { label } },
    }),
  );
}

async function mount() {
  await act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <UsageRouteScreen />
      </RegistryContext.Provider>,
    ),
  );
}
async function render() {
  await mount();
  // The screen opens on Limits; coverage lives on the Usage tab.
  await act(() => ui.press.get("Usage")!());
}
const visibleText = () => ui.text.join("\n");

beforeEach(() => {
  outcomes.clear();
  registry = AtomRegistry.make();
  backend.getRegistry = () => registry;
  backend.getPresentations = () => presentations;
  backend.getPresentation = presentation;
  backend.getQuery = queries;
  ui.text = [];
  ui.refresh = undefined;
  ui.press.clear();
  ui.selectEnvironment = undefined;
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
});
afterEach(async () => {
  await act(() => root.unmount());
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("mobile usage coverage with the actual useUsage hook", () => {
  it("opens on Limits and shows usage coverage only after switching to the Usage tab", async () => {
    addEnvironment(unavailable, "Unavailable host", Effect.fail(new Error("scan failed")));
    await mount();
    expect(visibleText()).not.toContain("could not report usage");
    await act(() => ui.press.get("Usage")!());
    expect(visibleText()).toContain("Unavailable host could not report usage");
  });

  it("shows an unavailable report instead of normal zero charts when the only environment fails", async () => {
    addEnvironment(unavailable, "Unavailable host", Effect.fail(new Error("scan failed")));
    await render();
    expect(visibleText()).toContain("Unavailable host could not report usage");
    expect(visibleText()).toContain("No usage reports are available");
    expect(visibleText()).not.toContain("Raw token cost");
    expect(visibleText()).not.toContain("No activity in this window");
  });

  it.each([3, USAGE_CONTRACT_VERSION + 1])(
    "explains exclusion instead of showing zero charts for incompatible-only version %s",
    async (version) => {
      addEnvironment(unavailable, "Incompatible host", Effect.succeed(summary(version)));
      await render();
      expect(visibleText()).toContain(
        "Incompatible host runs an incompatible server version and is excluded from totals",
      );
      expect(visibleText()).toContain("No usage reports are available");
      expect(visibleText()).not.toContain("Raw token cost");
    },
  );

  it("keeps healthy totals and visibly explains missing coverage from the failed environment", async () => {
    addEnvironment(healthy, "Healthy host", Effect.succeed(summary()));
    addEnvironment(unavailable, "Unavailable host", Effect.fail(new Error("scan failed")));
    await render();
    expect(visibleText()).toContain("$12.50*");
    expect(visibleText()).toContain("1.10K");
    expect(visibleText()).toContain(
      "Unavailable host could not report usage. Totals are incomplete.",
    );
    expect(visibleText()).not.toContain("No usage reports are available");
    expect(visibleText()).not.toContain("still reporting");
  });

  it("explains stale coverage after a failed refresh with retained data and clears it after recovery", async () => {
    addEnvironment(healthy, "Healthy host", Effect.succeed(summary()));
    await render();
    expect(visibleText()).toContain("$12.50*");
    expect(visibleText()).not.toContain("may be stale");
    outcomes.set(healthy, Effect.fail(new Error("refresh failed")));
    await act(async () => {
      ui.refresh!();
    });
    expect(registry.get(queries(healthy))._tag).toBe("Failure");
    expect(visibleText()).toContain("$12.50*");
    expect(visibleText()).toContain(
      "Healthy host could not refresh usage. Showing saved totals that may be stale.",
    );
    outcomes.set(healthy, Effect.succeed(summary()));
    await act(async () => {
      ui.refresh!();
    });
    expect(registry.get(queries(healthy))._tag).toBe("Success");
    expect(visibleText()).toContain("$12.50*");
    expect(visibleText()).not.toContain("may be stale");
  });

  it("removes failure coverage when the failed environment is deselected", async () => {
    addEnvironment(healthy, "Healthy host", Effect.succeed(summary()));
    addEnvironment(unavailable, "Unavailable host", Effect.fail(new Error("scan failed")));
    await render();
    await act(() => ui.selectEnvironment!({ nativeEvent: { event: unavailable } }));
    expect(visibleText()).toContain("$12.50*");
    expect(visibleText()).not.toContain("could not report usage");
    expect(visibleText()).not.toContain("Totals are incomplete");
  });

  it("still shows genuine zero usage when a compatible report has no activity", async () => {
    addEnvironment(healthy, "Healthy host", Effect.succeed({ ...summary(), buckets: [] }));
    await render();
    expect(visibleText()).toContain("Raw token cost");
    expect(visibleText()).toContain("No activity in this window");
    expect(visibleText()).not.toContain("No usage reports are available");
  });

  it("keeps healthy totals while an incompatible report is excluded", async () => {
    addEnvironment(healthy, "Healthy host", Effect.succeed(summary()));
    addEnvironment(unavailable, "Incompatible host", Effect.succeed(summary(3)));
    await render();
    expect(visibleText()).toContain("$12.50*");
    expect(visibleText()).toContain("Incompatible host runs an incompatible server version");
    expect(visibleText()).toContain("Totals are incomplete");
  });

  it("shows partial coverage while another environment is still reporting", async () => {
    addEnvironment(healthy, "Healthy host", Effect.succeed(summary()));
    addEnvironment(unavailable, "Scanning host", Effect.never);
    await render();
    expect(visibleText()).toContain("$12.50*");
    expect(visibleText()).toContain("Some environments are still reporting. Totals are partial.");
    expect(visibleText()).not.toContain("could not report usage");
  });

  it("explains saved coverage when an environment disconnects", async () => {
    addEnvironment(healthy, "Healthy host", Effect.succeed(summary()));
    await render();
    await act(() =>
      registry.set(
        presentations,
        new Map([
          [
            healthy,
            {
              connection: { phase: "disconnected" },
              entry: { target: { label: "Healthy host" } },
            },
          ],
        ]),
      ),
    );
    expect(visibleText()).toContain("$12.50*");
    expect(visibleText()).toContain(
      "Healthy host is disconnected. Showing saved totals that may be stale.",
    );
  });
});
