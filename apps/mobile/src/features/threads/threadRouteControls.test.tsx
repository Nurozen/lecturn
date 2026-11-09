import * as UserMessage from "@lecturn/client-runtime/user-message";
import { SquireId } from "@lecturn/contracts";
import * as AssistantCitations from "@lecturn/shared/assistantCitations";
import * as ComposerContextReferences from "@lecturn/shared/composerContextReferences";
import * as PromptLinks from "@lecturn/shared/promptLinks";
import * as React from "react";
import * as ReactCompilerRuntime from "react/compiler-runtime";
import * as ReactJsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import * as Cn from "../../lib/cn";
import { loadCompiledMobileModule } from "../../lib/reactCompilerModule.test-support";
import * as WideMarkdownBlocks from "../../lib/wideMarkdownBlocks";
import {
  allowsThreadRouteControl,
  resolveThreadRouteControls,
  SQUIRE_THREAD_CONTROLS,
  threadRouteHeaderActions,
  type ThreadRouteControl,
} from "./threadRouteControls";
import * as UserMessageIntentBadge from "./userMessageIntentBadge";

// Typed as a record so a control added to the union without a row here fails typecheck.
const EVERY_CONTROL: Record<ThreadRouteControl, true> = {
  copy: true,
  expand: true,
  "load-earlier": true,
  "image-preview": true,
  "mcp-app-actions": true,
  "composer-text": true,
  send: true,
  stop: true,
  "squire-details": true,
  "thread-actions": true,
  decisions: true,
  "squire-tracking": true,
  fork: true,
  "fork-from-response": true,
  "edit-pending-message": true,
  git: true,
  "merge-back": true,
  terminal: true,
  files: true,
  "project-scripts": true,
  "model-picker": true,
  "runtime-mode": true,
  "interaction-mode": true,
  attachments: true,
  compact: true,
  "usage-limits": true,
  contextual: true,
  "queued-runs": true,
  agents: true,
  previews: true,
  "artifact-templates": true,
  unsettle: true,
  "timeline-navigation": true,
};
const controls = Object.keys(EVERY_CONTROL) as ThreadRouteControl[];

const home = { squireId: SquireId.make("release"), role: "home" } as const;
const homeControls = resolveThreadRouteControls({ squire: home, squireSupported: true });
const ordinaryControls = resolveThreadRouteControls({ squire: undefined, squireSupported: true });

describe("thread route controls resolver", () => {
  it("denies every control outside the Squire set on a home thread", () => {
    expect(controls.filter((control) => allowsThreadRouteControl(homeControls, control))).toEqual([
      ...SQUIRE_THREAD_CONTROLS,
    ]);
  });

  it("keeps today's screen for ordinary threads, probes, and environments without Squires", () => {
    const unrestricted = [
      ordinaryControls,
      resolveThreadRouteControls({
        squire: { squireId: SquireId.make("release"), role: "probe" },
        squireSupported: true,
      }),
      resolveThreadRouteControls({ squire: home, squireSupported: false }),
    ];
    for (const resolved of unrestricted) {
      expect(resolved).toBeUndefined();
      expect(controls.every((control) => allowsThreadRouteControl(resolved, control))).toBe(true);
    }
  });

  it("offers only Squire details on a home thread, and Fork thread on an ordinary one", () => {
    const input = {
      decisionsSupported: true,
      forkSupported: true,
      homeSquireId: null,
      tracking: [{ kind: "track" as const, squireId: "docs", label: "Track with docs" }],
    };
    expect(
      threadRouteHeaderActions({ ...input, controls: homeControls, homeSquireId: "release" }),
    ).toEqual([{ kind: "squire-details", label: "Squire details", squireId: "release" }]);
    expect(
      threadRouteHeaderActions({ ...input, controls: ordinaryControls }).map(
        (action) => action.label,
      ),
    ).toEqual(["Decisions", "Fork thread", "Track with docs"]);
  });
});

// ── The feed's message controls, as Metro ships them ─────────────

/** The accessibility label of every interactive control the last render produced. */
let pressed: string[] = [];

function Passthrough(props: { readonly children?: React.ReactNode }) {
  return <>{props.children}</>;
}
function Nothing() {
  return null;
}
function Pressable(props: {
  readonly accessibilityLabel?: string;
  readonly children?: React.ReactNode;
}) {
  if (props.accessibilityLabel !== undefined) pressed.push(props.accessibilityLabel);
  return <>{props.children}</>;
}
function CopyTextButton(props: { readonly accessibilityLabel: string }) {
  pressed.push(props.accessibilityLabel);
  return null;
}
/** The `planSaveEnabled` each rendered work log received. */
let planSaves: Array<boolean | undefined> = [];
function ThreadWorkLog(props: { readonly planSaveEnabled?: boolean }) {
  planSaves.push(props.planSaveEnabled);
  return null;
}

// Imports the message rows never reach. Callable and chainable, so module-level setup like
// `FadeIn.delay(…).duration(…)` evaluates; never a class, so React would not construct one.
const unused: unknown = new Proxy(function unusedExport() {}, {
  get: (_, key) => (key === "__esModule" ? true : key === "prototype" ? undefined : unused),
  apply: () => unused,
});
const stubs: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": ReactJsxRuntime,
  "react/compiler-runtime": ReactCompilerRuntime,
  "react-native": {
    Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    View: Passthrough,
    Pressable,
    Text: Nothing,
    Image: Nothing,
  },
  "react-native-reanimated": {
    __esModule: true,
    default: { View: Passthrough },
    FadeIn: unused,
    FadeInUp: unused,
    ReduceMotion: { System: "system" },
  },
  "@react-navigation/native": {
    useNavigation: () => ({ navigate: () => {} }),
    useFocusEffect: () => {},
  },
  "@lecturn/client-runtime/user-message": UserMessage,
  "@lecturn/client-runtime/state/thread-workflows": { canForkProjectedAssistantItem: () => true },
  "@lecturn/shared/assistantCitations": AssistantCitations,
  "@lecturn/shared/composerContextReferences": ComposerContextReferences,
  "@lecturn/shared/promptLinks": PromptLinks,
  "../../lib/cn": Cn,
  "../../lib/wideMarkdownBlocks": WideMarkdownBlocks,
  "./userMessageIntentBadge": UserMessageIntentBadge,
  "./CopyTextButton": { CopyTextButton },
  "./thread-work-log": { ThreadWorkLog },
  "./pending-thread-feed": { isCompactionCommandFeedEntry: () => false },
  "../../lib/threadActivity": {
    isContextCompactionActivityGroup: () => false,
    isContextHandoffActivityGroup: () => false,
    isSecretRequestActivityGroup: () => false,
    isLinkRequestActivityGroup: () => false,
  },
  "./ThreadMarkdownImage": { MarkdownImageAvailableWidthContext: Nothing },
  "../../components/ui/Menu": { Menu: Passthrough },
  "../../components/ui/AppText": { AppText: Nothing },
  "../../components/ui/AppSymbol": { SymbolView: Nothing },
  "../../components/GlassCard": { GlassCard: Passthrough },
  "../contextual/ContextualMessageDisclosure": { ContextualMessageDisclosure: Nothing },
  // Forking advertised: the server forks and the provider session can fork this reply.
  "../../state/entities": {
    useEnvironmentServerConfig: () => ({ environment: { capabilities: { threadForking: true } } }),
  },
  "../../state/v2-item-support": {
    useV2ItemSupport: () => ({ providerSession: { capabilities: {} } }),
  },
  "../home/useThreadListActions": { useForkThreadAt: () => async () => null },
};
const modules = new Proxy(stubs, {
  has: () => true,
  get: (target, key: string) => (key in target ? target[key] : unused),
});

type RenderFeedEntry = (
  info: { readonly item: unknown; readonly index: number },
  props: Record<string, unknown>,
) => React.ReactNode;
let renderFeedEntry: RenderFeedEntry;

beforeAll(() => {
  renderFeedEntry = loadCompiledMobileModule({
    file: "src/features/threads/ThreadFeed.tsx",
    modules,
    expose: ["renderFeedEntry"],
  }).exports.renderFeedEntry as RenderFeedEntry;
});

const createdAt = "2026-01-01T00:00:00.000Z";
const pendingUserEntry = {
  type: "message",
  id: "pending",
  message: { id: "user-1", role: "user", text: "Check the release notes", createdAt },
  pendingMessage: { messageId: "user-1", attachments: [] },
  acknowledged: false,
};
const assistantEntry = {
  type: "message",
  id: "reply",
  message: {
    id: "assistant-1",
    role: "assistant",
    text: "The notes are ready.",
    createdAt,
    updatedAt: createdAt,
    runId: "run-1",
    streaming: false,
    projectedItem: {
      sourceThreadId: "thread-1",
      sourceItemId: "item-1",
      item: { runId: "run-1" },
    },
  },
};

/** The feed's rows as ThreadDetailScreen wires them from the resolved controls. */
function interactiveLabels(resolved: typeof homeControls): ReadonlyArray<string> {
  pressed = [];
  const props = {
    environmentId: "environment-1",
    threadId: "thread-1",
    threadTitle: "Release",
    dispatchingMessageId: null,
    onEditPendingMessage: allowsThreadRouteControl(resolved, "edit-pending-message")
      ? () => {}
      : null,
    forkEnabled: allowsThreadRouteControl(resolved, "fork-from-response"),
    terminalAssistantMessageIds: new Set(["assistant-1"]),
    failedRunIds: new Set(),
    runlessForkPoints: new Map(),
    unsettledTurnId: null,
    userMessageGrouping: { continuesSteer: false, groupedWithNext: false },
    replyActionSize: { button: 32, icon: 13 },
    workflowOpening: null,
    markdownStyles: { user: {}, assistant: {} },
    duoColumns: false,
    userBubbleMaxWidth: 320,
    markdownContentWidth: 320,
    reviewCommentBubbleWidth: 320,
  };
  renderToStaticMarkup(
    <>
      {renderFeedEntry({ item: pendingUserEntry, index: 0 }, props)}
      {renderFeedEntry({ item: assistantEntry, index: 1 }, props)}
    </>,
  );
  return pressed;
}

const LABEL_CONTROL: Record<string, ThreadRouteControl> = {
  "Copy message": "copy",
  "Edit pending message": "edit-pending-message",
  "Fork from this response": "fork-from-response",
};

describe("thread feed controls", () => {
  it("compiles ThreadFeed as Metro ships it", () => {
    expect(renderFeedEntry).toBeTypeOf("function");
  });

  it("shows a home thread only the Squire controls, with forking advertised", () => {
    const labels = interactiveLabels(homeControls);
    expect(labels).toEqual(["Copy message", "Copy message"]);
    expect(labels.every((label) => SQUIRE_THREAD_CONTROLS.has(LABEL_CONTROL[label]!))).toBe(true);
  });

  it("still offers Fork and Edit on an ordinary thread", () => {
    expect(interactiveLabels(ordinaryControls)).toEqual([
      "Edit pending message",
      "Copy message",
      "Copy message",
      "Fork from this response",
    ]);
  });
});

describe("proposed plan controls", () => {
  const planEntry = {
    type: "activity-group",
    id: "plan",
    activities: [{ projectedItem: { item: { type: "proposed_plan", markdown: "# Plan" } } }],
  };

  /** The work log's plan save switch as ThreadDetailScreen wires it from the resolved controls. */
  function planSaveEnabled(resolved: typeof homeControls) {
    planSaves = [];
    renderToStaticMarkup(
      <>
        {renderFeedEntry(
          { item: planEntry, index: 0 },
          {
            environmentId: "environment-1",
            threadId: "thread-1",
            planSaveEnabled: allowsThreadRouteControl(resolved, "files"),
            workRowSizing: { textSizeKey: "default" },
          },
        )}
      </>,
    );
    return planSaves;
  }

  it("hides Save to workspace on a home thread", () => {
    expect(planSaveEnabled(homeControls)).toEqual([false]);
  });

  it("keeps Save to workspace on an ordinary thread", () => {
    expect(planSaveEnabled(ordinaryControls)).toEqual([true]);
  });
});
