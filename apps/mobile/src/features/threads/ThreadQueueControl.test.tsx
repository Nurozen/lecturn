import * as React from "react";
import * as ReactCompilerRuntime from "react/compiler-runtime";
import * as ReactJsxRuntime from "react/jsx-runtime";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { loadCompiledMobileModule } from "../../lib/reactCompilerModule.test-support";

// Whether the drag handle keeps one gesture between renders is decided by the React Compiler,
// so this suite runs the queue module exactly as Metro ships it to Android and stubs the
// modules around the handle.
interface PanEvent {
  readonly translationY: number;
}

class PanGestureStub {
  readonly config: { enabled?: boolean } = {};
  readonly callbacks: {
    onStart?: () => void;
    onUpdate?: (event: PanEvent) => void;
    onFinalize?: (event: PanEvent, success: boolean) => void;
  } = {};
  enabled(enabled: boolean) {
    this.config.enabled = enabled;
    return this;
  }
  minDistance() {
    return this;
  }
  shouldCancelWhenOutside() {
    return this;
  }
  runOnJS() {
    return this;
  }
  onStart(callback: () => void) {
    this.callbacks.onStart = callback;
    return this;
  }
  onUpdate(callback: (event: PanEvent) => void) {
    this.callbacks.onUpdate = callback;
    return this;
  }
  onFinalize(callback: (event: PanEvent, success: boolean) => void) {
    this.callbacks.onFinalize = callback;
    return this;
  }
}

// Every gesture the detector receives, in render order.
let detectedGestures: PanGestureStub[] = [];

function Passthrough(props: { readonly children?: React.ReactNode }) {
  return <>{props.children}</>;
}

// Proxy for imports only the queue sheet and its rows touch; the drag handle never reads them.
const unusedExport: unknown = new Proxy(() => unusedExport, {
  get: (_, key) => (key === "__esModule" ? true : unusedExport),
  apply: () => unusedExport,
});
const unusedModules = [
  "@react-navigation/native",
  "@effect/atom-react",
  "effect/reactivity",
  "expo-image",
  "expo-haptics",
  "react-native-gesture-handler/ReanimatedSwipeable",
  "react-native-screens",
  "react-native-safe-area-context",
  "react-native-reanimated",
  "../../components/ui/Button",
  "../../components/ui/AndroidScreenHeader",
  "../../components/ui/AppText",
  "../../components/ui/Menu",
  "../../components/ui/ScreenContent",
  "../../lib/scopedEntities",
  "../../lib/useUniwindTheme",
  "../../native/StackHeader",
  "../../state/assets",
  "../../lib/assetImageSource",
  "../../state/queued-run-edit",
  "../../state/threads",
  "../../state/use-atom-command",
  "../layout/AdaptiveWorkspaceLayout",
  "./threadQueueControlPresentation",
  "./threadDragGap",
];

const stubModules: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": ReactJsxRuntime,
  "react/compiler-runtime": ReactCompilerRuntime,
  "react-native": {
    Platform: {
      OS: "android",
      Version: 35,
      select: (options: { android?: unknown }) => options.android,
    },
    View: Passthrough,
  },
  "react-native-gesture-handler": {
    Gesture: { Pan: () => new PanGestureStub() },
    GestureDetector: (props: {
      readonly gesture: PanGestureStub;
      readonly children: React.ReactNode;
    }) => {
      detectedGestures.push(props.gesture);
      return props.children;
    },
  },
  "../../components/ui/AppSymbol": { SymbolView: () => null },
  ...Object.fromEntries(unusedModules.map((specifier) => [specifier, unusedExport])),
};

interface DragHandleProps {
  readonly disabled: boolean;
  readonly title: string;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onStep: (action: "up" | "down") => void;
  readonly onStart: () => void;
  readonly onMove: (y: number) => void;
  readonly onEnd: (y: number, success: boolean) => void;
}

let QueueDragHandle: (props: DragHandleProps) => React.ReactNode;
let compilerEvents: readonly string[] = [];

beforeAll(() => {
  // The handle is private to the module, so the harness exposes it after the module body.
  const compiled = loadCompiledMobileModule({
    file: "src/features/threads/ThreadQueueControl.tsx",
    modules: stubModules,
    expose: ["QueueDragHandle"],
  });
  compilerEvents = compiled.compilerEvents;
  QueueDragHandle = compiled.exports.QueueDragHandle as typeof QueueDragHandle;
});

// A parent like the queue sheet: fresh handler closures on every render.
function handleProps(disabled: boolean) {
  return {
    disabled,
    title: "Fix the flaky test",
    canMoveUp: true,
    canMoveDown: true,
    onStep: vi.fn<(action: "up" | "down") => void>(),
    onStart: vi.fn<() => void>(),
    onMove: vi.fn<(y: number) => void>(),
    onEnd: vi.fn<(y: number, success: boolean) => void>(),
  };
}

let root: Root;
async function renderHandle(props: DragHandleProps) {
  await React.act(() => root.render(<QueueDragHandle {...props} />));
}

beforeEach(() => {
  detectedGestures = [];
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
  await React.act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("queue drag handle gesture", () => {
  it("runs the React Compiler output Metro ships", () => {
    expect(compilerEvents).toContain("CompileSuccess");
    expect(compilerEvents.filter((kind) => kind !== "CompileSuccess")).toEqual([]);
  });

  it("keeps one gesture while the handle re-renders with the same disabled state", async () => {
    for (let index = 0; index < 4; index += 1) {
      await renderHandle(handleProps(false));
    }

    expect(detectedGestures).toHaveLength(4);
    expect(new Set(detectedGestures).size).toBe(1);
    expect(detectedGestures[0]?.config.enabled).toBe(true);
  });

  it("runs the latest render's handlers from the gesture built on the first", async () => {
    const first = handleProps(false);
    const latest = handleProps(false);
    await renderHandle(first);
    await renderHandle(handleProps(false));
    await renderHandle(latest);
    const gesture = detectedGestures.at(-1)!;

    gesture.callbacks.onStart?.();
    gesture.callbacks.onUpdate?.({ translationY: 12 });
    gesture.callbacks.onFinalize?.({ translationY: 30 }, true);

    expect(gesture).toBe(detectedGestures[0]);
    expect(latest.onStart).toHaveBeenCalledOnce();
    expect(latest.onMove).toHaveBeenCalledWith(12);
    expect(latest.onEnd).toHaveBeenCalledWith(30, true);
    expect(first.onStart).not.toHaveBeenCalled();
    expect(first.onMove).not.toHaveBeenCalled();
    expect(first.onEnd).not.toHaveBeenCalled();
  });

  it("builds a new gesture only when disabled changes", async () => {
    await renderHandle(handleProps(false));
    await renderHandle(handleProps(true));
    await renderHandle(handleProps(true));
    await renderHandle(handleProps(false));

    const [enabled, disabled, stillDisabled, reenabled] = detectedGestures;
    expect(disabled).not.toBe(enabled);
    expect(stillDisabled).toBe(disabled);
    // Never a reused gesture: GestureDetector copies a new gesture's config onto the one it
    // attached first, so swapping back to that object would keep the disabled config.
    expect(reenabled).not.toBe(disabled);
    expect(reenabled).not.toBe(enabled);
    expect(detectedGestures.map((gesture) => gesture.config.enabled)).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });
});
