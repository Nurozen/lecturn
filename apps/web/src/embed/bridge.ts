import { makeEmbedGuest, type EmbedHostCommand } from "@lecturn/client-runtime/embed/guest";
import { matchesAppEmbedOrigin, type AppEmbedOrigin } from "@lecturn/contracts";
import {
  EMBED_DESCRIBE_REFS_MAX,
  type EmbedHostContext,
  type EmbedTurnState,
} from "@lecturn/contracts/embedBridge";

import { readEmbedParentOrigin } from "./embedAuth";
import { setEmbedTokenRefresher } from "./embedPrimaryAuth";

// `EMBED_GUEST_HOST_GLOBAL` in packages/embed/src/channels.ts, which web cannot import.
const ELECTRON_HOST_GLOBAL = "lecturnEmbedHost";
// What the guest may say before it learns whether its parent is allowed: the handshake, plus
// whatever the view reports while the app context loads.
const MAX_HELD_MESSAGES = 64;

export interface EmbedTransport {
  readonly post: (message: unknown) => void;
  /** Whether a `message` event came from the host, and not from a card frame or another page. */
  readonly accepts: (event: MessageEvent) => boolean;
  /**
   * Opens the transport once the app's declared origins are known. A parent on any other origin
   * framed this view without the app's say, so it is never answered.
   */
  readonly authorize: (embedOrigins: ReadonlyArray<AppEmbedOrigin>) => void;
}

type BridgeWindow = Pick<Window, "addEventListener" | "removeEventListener" | "parent"> & {
  readonly location: Pick<Location, "origin">;
};

/**
 * An Electron host's helper preload exposes a way out and re-posts host messages to this window
 * from its isolated world, so they arrive same-origin from this window. An iframe host talks over
 * `postMessage` with the parent, pinned to the origin it named in the hash; without one there is
 * no origin to trust, so there is no bridge. The hash is the host's own claim, so the frame stays
 * silent until that origin is checked against the app's declared `embedOrigins`.
 */
export function resolveEmbedTransport(
  win: BridgeWindow,
  parentOrigin: string | null,
): EmbedTransport | null {
  const electronHost = Reflect.get(win, ELECTRON_HOST_GLOBAL) as
    | { readonly postMessage?: unknown }
    | undefined;
  if (typeof electronHost?.postMessage === "function") {
    const postToHost = electronHost.postMessage as (message: unknown) => void;
    return {
      post: (message) => postToHost.call(electronHost, message),
      accepts: (event) => event.source === win && event.origin === win.location.origin,
      authorize: () => undefined,
    };
  }
  if (win.parent === win || parentOrigin === null) return null;
  const parent = win.parent;
  let state: "pending" | "open" | "closed" = "pending";
  let held: Array<unknown> = [];
  return {
    post: (message) => {
      if (state === "open") parent.postMessage(message, parentOrigin);
      else if (state === "pending" && held.length < MAX_HELD_MESSAGES) held.push(message);
    },
    accepts: (event) =>
      state === "open" && event.source === parent && event.origin === parentOrigin,
    authorize: (embedOrigins) => {
      if (state !== "pending") return;
      state = matchesAppEmbedOrigin(parentOrigin, embedOrigins) ? "open" : "closed";
      const flushed = held;
      held = [];
      if (state === "open")
        for (const message of flushed) parent.postMessage(message, parentOrigin);
    },
  };
}

export interface EmbedBridge {
  readonly hostContext: () => EmbedHostContext | null;
  readonly subscribeHostContext: (listener: (context: EmbedHostContext) => void) => () => void;
  readonly subscribeHostCommands: (listener: (command: EmbedHostCommand) => void) => () => void;
  /** Tells the host which thread the view shows; repeats are not sent. */
  readonly reportThread: (threadId: string | null) => void;
  readonly reportTurnState: (threadId: string, state: EmbedTurnState) => void;
  /** The view has drawn this thread (or its empty state); hosts wait on it before capturing. */
  readonly reportReady: (threadId: string | null) => void;
  /** The user activated an app reference; the host decides what it opens. */
  readonly navigate: (ref: string) => void;
  /** Asks the host to open a link outside the view (`ui/open-link`); the host may refuse it. */
  readonly openLink: (url: string) => Promise<void>;
  /** Asks the host what its references are called; refs it cannot name are left out. */
  readonly describeRefs: (refs: ReadonlyArray<string>) => Promise<Readonly<Record<string, string>>>;
  readonly authorizeHost: (embedOrigins: ReadonlyArray<AppEmbedOrigin>) => void;
  readonly dispose: () => void;
}

export function createEmbedBridge(transport: EmbedTransport, win: BridgeWindow): EmbedBridge {
  const contextListeners = new Set<(context: EmbedHostContext) => void>();
  const commandListeners = new Set<(command: EmbedHostCommand) => void>();
  let reportedThread: string | null | undefined;
  let reportedTurn: string | undefined;
  let reportedReady: string | null | undefined;

  const guest = makeEmbedGuest({
    post: transport.post,
    onHostContext: (context) => {
      for (const listener of contextListeners) listener(context);
    },
    onHostCommand: (command) => {
      for (const listener of commandListeners) listener(command);
    },
  });
  const onMessage = (event: Event) => {
    const message = event as MessageEvent;
    if (transport.accepts(message)) guest.receive(message.data);
  };
  win.addEventListener("message", onMessage);
  // The socket's session ends with the token, so embedPrimaryAuth asks for the next one ahead of
  // expiry and reconnects on it; the host is the only one that can mint it.
  setEmbedTokenRefresher(() => guest.request("lecturn/token.refresh", {}));
  // A host that refuses the handshake gets nothing; the view still works until its token expires.
  guest.initialize().catch(() => undefined);

  const subscribe =
    <A>(listeners: Set<(value: A) => void>) =>
    (listener: (value: A) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };

  return {
    hostContext: guest.hostContext,
    subscribeHostContext: subscribe(contextListeners),
    subscribeHostCommands: subscribe(commandListeners),
    reportThread(threadId) {
      if (threadId === reportedThread) return;
      reportedThread = threadId;
      reportedTurn = undefined;
      guest.notify("lecturn/thread.changed", { threadId });
    },
    reportTurnState(threadId, state) {
      const key = `${threadId}\u0000${state}`;
      if (key === reportedTurn) return;
      reportedTurn = key;
      guest.notify("lecturn/turn.state", { threadId, state });
    },
    reportReady(threadId) {
      if (threadId === reportedReady) return;
      reportedReady = threadId;
      guest.notify("lecturn/ready", { threadId });
    },
    navigate(ref) {
      guest.notify("lecturn/navigate", { ref });
    },
    async openLink(url) {
      await guest.request("ui/open-link", { url });
    },
    async describeRefs(refs) {
      const labels: Record<string, string> = {};
      for (let start = 0; start < refs.length; start += EMBED_DESCRIBE_REFS_MAX) {
        const chunk = refs.slice(start, start + EMBED_DESCRIBE_REFS_MAX);
        const result = await guest.request("lecturn/appRefs.describe", { refs: chunk });
        for (const ref of chunk) {
          const label = Object.hasOwn(result.labels, ref) ? result.labels[ref] : undefined;
          if (label !== undefined) labels[ref] = label;
        }
      }
      return labels;
    },
    authorizeHost: transport.authorize,
    dispose() {
      win.removeEventListener("message", onMessage);
      setEmbedTokenRefresher(null);
      guest.dispose();
      contextListeners.clear();
      commandListeners.clear();
    },
  };
}

let current: EmbedBridge | null = null;

/** One bridge per document: the host's handshake is per page load, not per thread. */
export function startEmbedBridge(win: BridgeWindow = window): EmbedBridge | null {
  if (current !== null) return current;
  const transport = resolveEmbedTransport(win, readEmbedParentOrigin());
  if (transport === null) return null;
  current = createEmbedBridge(transport, win);
  return current;
}

export function readEmbedBridge(): EmbedBridge | null {
  return current;
}

export function __resetEmbedBridgeForTests(): void {
  current?.dispose();
  current = null;
}
