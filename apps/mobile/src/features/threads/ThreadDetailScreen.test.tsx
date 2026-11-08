import * as ThreadRequests from "@lecturn/client-runtime/state/thread-requests";
import { AppId, RuntimeRequestId, SquireId } from "@lecturn/contracts";
import * as React from "react";
import * as ReactCompilerRuntime from "react/compiler-runtime";
import * as ReactJsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { AsyncResult } from "effect/reactivity";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { loadCompiledMobileModule } from "../../lib/reactCompilerModule.test-support";
import {
  allowsThreadRouteControl,
  resolveThreadRouteControls,
  SQUIRE_THREAD_CONTROLS,
  type ThreadRouteControls,
} from "./threadRouteControls";

interface ComposerProps {
  readonly placeholder: string;
  readonly followUpBehavior: string;
  readonly onSendMessage: () => Promise<unknown>;
}

/** What the last render handed the composer and the feed, and the labels of what it pressed. */
const rendered = {
  composer: null as ComposerProps | null,
  turnDiffEnabled: undefined as boolean | undefined,
  renderFeedItem: null as ((info: { item: unknown; index: number }) => React.ReactNode) | null,
  labels: [] as string[],
};

// What the screens read but these tests do not look at: hook results, config, and helpers.
// Callable, chainable, empty when spread, and blank when stringified or compared.
const unused: unknown = new Proxy(function unusedExport() {}, {
  get: (_, key) => {
    if (key === "__esModule") return true;
    if (key === "prototype") return undefined;
    if (key === Symbol.toPrimitive) return () => "";
    if (key === Symbol.iterator) return () => [][Symbol.iterator]();
    return unused;
  },
  apply: () => unused,
});
// Capitalized exports are rendered, read as namespaces (`Animated.View`), or chained as builders
// (`FadeIn.delay(100).duration(200)`). React is the caller that passes a props object.
const passthrough: unknown = new Proxy(function Passthrough() {}, {
  get: (_, key) => {
    if (key === "prototype") return undefined;
    if (key === Symbol.toPrimitive) return () => "";
    return passthrough;
  },
  apply: (_, __, [props]) =>
    typeof props === "object" && props !== null ? <>{props.children}</> : passthrough,
});
const stubbed = (overrides: Record<string, unknown> = {}) =>
  new Proxy(overrides, {
    get: (target, key) => {
      if (key === "__esModule") return true;
      if (typeof key === "string" && key in target) return target[key];
      // `default` is the `Animated` of `react-native-reanimated`.
      return typeof key === "string" && /^([A-Z]|default$)/.test(key) ? passthrough : unused;
    },
  });
const modulesWith = (overrides: Record<string, unknown>) =>
  new Proxy(
    {
      // Static markup rendering rejects a store subscription that has no server snapshot.
      react: {
        ...React,
        useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
      },
      "react/jsx-runtime": ReactJsxRuntime,
      "react/compiler-runtime": ReactCompilerRuntime,
      ...overrides,
    } as Record<string, unknown>,
    {
      has: () => true,
      get: (target, key: string) => (key in target ? target[key] : stubbed()),
    },
  );

type Screen = (props: Record<string, unknown>) => React.ReactNode;
let DetailScreen: Screen;
let FeedView: Screen;
beforeAll(() => {
  DetailScreen = loadCompiledMobileModule({
    file: "src/features/threads/ThreadDetailScreen.tsx",
    modules: modulesWith({
      "@lecturn/client-runtime/state/thread-requests": ThreadRequests,
      "@lecturn/contracts": stubbed({ isProviderNativeSubagentThread: () => false }),
      "./threadRouteControls": { allowsThreadRouteControl },
      "./ThreadComposer": {
        ThreadComposer: (props: ComposerProps) => {
          rendered.composer = props;
          return null;
        },
      },
      "./ThreadFeed": {
        ThreadFeed: (props: { readonly turnDiffEnabled: boolean }) => {
          rendered.turnDiffEnabled = props.turnDiffEnabled;
          return null;
        },
      },
    }),
    expose: ["ThreadDetailBody"],
  }).exports.ThreadDetailBody as never;
  FeedView = loadCompiledMobileModule({
    file: "src/features/threads/ThreadFeed.tsx",
    modules: modulesWith({
      "@legendapp/list/keyboard": {
        KeyboardAwareLegendList: (props: {
          readonly renderItem: NonNullable<typeof rendered.renderFeedItem>;
        }) => {
          rendered.renderFeedItem = props.renderItem;
          return null;
        },
      },
      "react-native": stubbed({
        Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
        StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
        Pressable: (props: {
          readonly accessibilityLabel?: string;
          readonly children?: React.ReactNode;
        }) => {
          if (props.accessibilityLabel !== undefined)
            rendered.labels.push(props.accessibilityLabel);
          return <>{props.children}</>;
        },
      }),
    }),
    expose: ["ThreadFeedView"],
  }).exports.ThreadFeedView as never;
});

/** Props and records these tests name, with every other field stubbed. */
const onlyTheFields = (fields: Record<string, unknown>) =>
  new Proxy(fields, { get: (target, key) => (key in target ? target[key as string] : unused) });
/** Calls the component itself, because React copies a props object and would lose the stub. */
const renderWith = (
  component: (props: Record<string, unknown>) => React.ReactNode,
  fields: Record<string, unknown>,
) => {
  const Rendered = () => component(onlyTheFields(fields));
  renderToStaticMarkup(<Rendered />);
};

function renderDetailScreen(input: {
  readonly approvals?: ReadonlyArray<ThreadRequests.ThreadPendingApproval>;
  readonly controls?: ThreadRouteControls | undefined;
}) {
  const approvals = input.approvals ?? [];
  const onRespondToApproval = vi.fn(async () => AsyncResult.success(undefined));
  // What the composer state does with a redirect: it runs the decline, then dispatches.
  const onSendMessage = vi.fn(
    async (_followUp: unknown, beforeDispatch?: () => Promise<boolean>) => {
      await beforeDispatch?.();
      return null;
    },
  );
  rendered.composer = null;
  renderWith(DetailScreen, {
    controls: input.controls,
    draftMode: undefined,
    selectedThread: onlyTheFields({ id: "thread-1", importedFrom: null }),
    selectedThreadFeed: [],
    contentPresentation: { kind: "ready" },
    activePendingApproval: approvals[0] ?? null,
    activePendingApprovals: approvals,
    activePendingUserInput: null,
    creationState: null,
    respondingApprovalId: null,
    followUpBehavior: "queue",
    composerPlaceholder: "Ask the agent",
    onRespondToApproval,
    onSendMessage,
  });
  return { composer: rendered.composer!, onRespondToApproval, onSendMessage };
}

const providerApproval: ThreadRequests.ThreadPendingApproval = {
  requestId: RuntimeRequestId.make("provider-approval"),
  requestKind: "command",
  createdAt: "2026-10-25T00:00:00.000Z",
  responseCapability: "live",
};
const appApproval: ThreadRequests.ThreadPendingApproval = {
  ...providerApproval,
  requestId: RuntimeRequestId.make("app-approval"),
  connectedAppTool: {
    appId: AppId.make("dev.rocketwright"),
    appName: "RocketWright",
    toolName: "rw_simulate",
    reason: null,
    source: "static",
  },
};

describe("sending with approvals pending", () => {
  it("declines provider approvals and steers the turn", async () => {
    const { composer, onRespondToApproval, onSendMessage } = renderDetailScreen({
      approvals: [providerApproval],
    });
    expect(composer.placeholder).toBe("Send a message to decline and redirect the agent");
    expect(composer.followUpBehavior).toBe("steer");

    await composer.onSendMessage();

    expect(onSendMessage).toHaveBeenCalledWith(undefined, expect.any(Function));
    expect(onRespondToApproval).toHaveBeenCalledWith(providerApproval.requestId, "decline");
  });

  it.each([
    ["alone", [appApproval]],
    ["behind a provider approval", [providerApproval, appApproval]],
    ["ahead of a provider approval", [appApproval, providerApproval]],
  ])("declines nothing with an app tool approval %s", async (_name, approvals) => {
    const { composer, onRespondToApproval, onSendMessage } = renderDetailScreen({ approvals });
    expect(composer.placeholder).toBe("Ask the agent");
    expect(composer.followUpBehavior).toBe("queue");

    await composer.onSendMessage();

    expect(onSendMessage).toHaveBeenCalledWith(undefined, undefined);
    expect(onRespondToApproval).not.toHaveBeenCalled();
  });
});

describe("turn diff stat", () => {
  const homeControls = resolveThreadRouteControls({
    squire: { squireId: SquireId.make("release"), role: "home" },
    squireSupported: true,
  });
  const runFold = {
    type: "run-fold",
    id: "run-fold",
    label: "Worked for 2s",
    expanded: false,
    runId: "run-1",
    checkpointSummary: { files: [{ additions: 3, deletions: 1 }] },
  };

  /** The review shortcut as the feed renders it from the screen's `turnDiffEnabled`. */
  function feedLabels(turnDiffEnabled: boolean) {
    rendered.labels = [];
    renderWith(FeedView, {
      environmentId: "environment-1",
      threadId: "thread-1",
      feed: [],
      queuedMessages: [],
      contentPresentation: { kind: "ready" },
      turnDiffEnabled,
      workRowSizing: { textSizeKey: "default" },
    });
    renderToStaticMarkup(<>{rendered.renderFeedItem!({ item: runFold, index: 0 })}</>);
    return rendered.labels;
  }

  it("follows the git control", () => {
    expect(SQUIRE_THREAD_CONTROLS.has("git")).toBe(false);
    renderDetailScreen({ controls: homeControls });
    expect(rendered.turnDiffEnabled).toBe(false);
    renderDetailScreen({});
    expect(rendered.turnDiffEnabled).toBe(true);
  });

  it("offers the review only while the git control is allowed", () => {
    const review = "Review 1 file changed, 3 additions, 1 deletions";
    expect(feedLabels(true)).toContain(review);
    expect(feedLabels(false)).not.toContain(review);
  });
});
