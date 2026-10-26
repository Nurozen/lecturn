import type {
  EmbedHostNotificationParams,
  EmbedTokenRefreshResult,
} from "@lecturn/contracts/embedBridge";

import { EmbedViewError } from "./electron/errors.ts";
import {
  assertHostContextFits,
  createEmbedHostSession,
  type EmbedBridgeEvent,
  type EmbedBridgeEvents,
  type EmbedDescribeRefs,
  type EmbedThemeInput,
  hostContextFor,
} from "./electron/hostBridge.ts";
import { embedGuestUrl, isExternalLink } from "./embedUrl.ts";
import type { EmbedTarget } from "./target.ts";

export { EmbedViewError } from "./electron/errors.ts";
export type { EmbedViewErrorReason } from "./electron/errors.ts";
export type {
  EmbedBridgeEvent,
  EmbedBridgeEvents,
  EmbedDescribeRefs,
  EmbedRefLabels,
  EmbedThemeInput,
} from "./electron/hostBridge.ts";
export type { EmbedTarget } from "./target.ts";

export interface MountEmbedOptions {
  readonly url: string;
  readonly token: string;
  readonly theme: EmbedThemeInput;
  /** Replaces the idle composer prompt (up to 200 characters); without it Lecturn's own shows. */
  readonly composerPlaceholder?: string;
  /** False hides the view's own thread switcher, for hosts that list threads themselves. */
  readonly switcher?: boolean;
  /** Mints the next embed token; the view asks ahead of expiry. */
  readonly onTokenRefresh: () => Promise<EmbedTokenRefreshResult>;
  /** A card's `ui/open-link`. Without it, http(s) and `lecturn://apps` links open in a new tab. */
  readonly onOpenLink?: (url: string) => void | Promise<void>;
  /**
   * Names the references a thread shows that no message stored a name for, such as ones the agent
   * wrote. Without it, or for a reference it leaves out, the chip shows the reference itself.
   */
  readonly onDescribeRefs?: EmbedDescribeRefs;
}

type BridgeListener<E extends EmbedBridgeEvent | "error"> = (
  payload: E extends EmbedBridgeEvent ? EmbedBridgeEvents[E] : EmbedViewError,
) => void;

export interface EmbedBridge {
  readonly iframe: HTMLIFrameElement;
  insertMention(params: EmbedHostNotificationParams<"lecturn/composer.insertMention">): void;
  setDraft(text: string): void;
  openThread(threadId: string): void;
  newThread(params?: EmbedHostNotificationParams<"lecturn/thread.new">): void;
  openProviders(): void;
  setTheme(theme: EmbedThemeInput): void;
  /** Null hands the idle composer prompt back to Lecturn's wording. */
  setComposerPlaceholder(placeholder: string | null): void;
  setVisible(visible: boolean): void;
  /** Loads another target in the same frame; what was queued for the old one is dropped. */
  retarget(target: Pick<EmbedTarget, "url" | "token">): void;
  on<E extends EmbedBridgeEvent | "error">(event: E, listener: BridgeListener<E>): () => void;
  destroy(): void;
}

const isInitializeRequest = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "id" in data &&
  (data as { readonly method?: unknown }).method === "ui/initialize";

/**
 * Mounts the embed view in an iframe inside `container`. Messages are taken only from that frame at
 * the target's origin and posted only to that origin, so another frame or a page the guest
 * navigated to can neither drive the host nor read what it sends.
 */
export function mountEmbed(container: HTMLElement, options: MountEmbedOptions): EmbedBridge {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  if (win === null) {
    throw new EmbedViewError("load-failed", "The container is not in a window's document.");
  }
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const listeners = new Map<string, Set<(payload: never) => void>>();
  let destroyed = false;
  let guestOrigin = new URL(options.url).origin;

  // oxlint-disable-next-line react/iframe-missing-sandbox -- The rule reads JSX props; the sandbox is set on the element below.
  const iframe = doc.createElement("iframe");
  iframe.title = "Lecturn";
  iframe.setAttribute("allow", "clipboard-write");
  // The view is a full Lecturn page on its own origin, so it keeps scripts and that origin; what
  // the sandbox withholds is navigating the host page.
  iframe.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
  );
  iframe.style.cssText = "display:block;width:100%;height:100%;border:0";

  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) (listener as (p: unknown) => void)(payload);
  };
  const emitError = (error: EmbedViewError) => emit("error", error);

  let theme = options.theme;
  let composerPlaceholder = options.composerPlaceholder ?? null;
  const initialContext = hostContextFor(theme, locale, composerPlaceholder);
  assertHostContextFits(initialContext);
  const session = createEmbedHostSession(initialContext, {
    send: (message) => {
      if (!destroyed) iframe.contentWindow?.postMessage(message, guestOrigin);
    },
    refreshToken: options.onTokenRefresh,
    openLink: async (url) => {
      if (options.onOpenLink !== undefined) {
        await options.onOpenLink(url);
        return;
      }
      if (!isExternalLink(url)) {
        throw new Error("Only http, https and lecturn links open outside the embed view.");
      }
      win.open(url, "_blank", "noopener,noreferrer");
    },
    ...(options.onDescribeRefs === undefined ? {} : { describeRefs: options.onDescribeRefs }),
    emit: (event, payload) => emit(event, payload),
    emitError,
  });

  const onMessage = (event: MessageEvent) => {
    if (destroyed || event.source !== iframe.contentWindow || event.origin !== guestOrigin) return;
    // A frame posts no navigation event to its parent; a fresh handshake is how a reloaded
    // guest shows up, and it must not inherit the old document's state.
    if (isInitializeRequest(event.data)) session.resetDocument();
    session.handleGuestMessage(event.data);
  };
  win.addEventListener("message", onMessage);

  const load = (url: string, token: string) => {
    guestOrigin = new URL(url).origin;
    iframe.src = embedGuestUrl(url, token, {
      parentOrigin: win.location.origin,
      switcher: options.switcher !== false,
    });
  };
  load(options.url, options.token);
  container.appendChild(iframe);

  const requireLive = () => {
    if (destroyed) throw new EmbedViewError("guest-gone", "The embed view was destroyed.");
  };

  return {
    iframe,
    insertMention: (params) => {
      requireLive();
      session.notify("lecturn/composer.insertMention", params);
    },
    setDraft: (text) => {
      requireLive();
      session.notify("lecturn/composer.setDraft", { text });
    },
    openThread: (threadId) => {
      requireLive();
      session.notify("lecturn/thread.open", { threadId });
    },
    newThread: (params = {}) => {
      requireLive();
      session.notify("lecturn/thread.new", params);
    },
    openProviders: () => {
      requireLive();
      session.notify("lecturn/providers.open", {});
    },
    setTheme: (next) => {
      requireLive();
      session.setHostContext(hostContextFor(next, locale, composerPlaceholder));
      theme = next;
    },
    setComposerPlaceholder: (next) => {
      requireLive();
      session.setHostContext(hostContextFor(theme, locale, next));
      composerPlaceholder = next;
    },
    setVisible: (visible) => {
      iframe.hidden = !visible;
    },
    retarget: (target) => {
      requireLive();
      session.clearQueue();
      session.resetDocument();
      load(target.url, target.token);
    },
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (payload: never) => void);
      listeners.set(event, set);
      return () => set.delete(listener as (payload: never) => void);
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      win.removeEventListener("message", onMessage);
      listeners.clear();
      iframe.remove();
    },
  };
}
