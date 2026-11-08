import type { SquireEnvironmentState } from "@lecturn/client-runtime/state/squire";
import type {
  AppBinding,
  AppId,
  EnvironmentId,
  SquireActionLogEntry,
  SquireCardId,
  SquireId,
  ThreadId,
} from "@lecturn/contracts";
import type { ClientSettings } from "@lecturn/contracts/settings";

import completionUrl from "./assets/notification-completion.mp3";
import inputUrl from "./assets/notification-input.mp3";
import { useThreadSelectionStore } from "./threadSelectionStore";
import { useUiStateStore } from "./uiStateStore";

type NotificationMode = ClientSettings["notificationMode"];
export const NOTIFICATION_MODE_LABELS = {
  off: "Off",
  notifications: "Notifications only",
  sound: "Sound only",
  "notifications-and-sound": "Notifications with sound",
} satisfies Record<NotificationMode, string>;

export function hasNotificationSound(mode: NotificationMode) {
  return mode === "sound" || mode === "notifications-and-sound";
}

export function hasDesktopNotifications(mode: NotificationMode) {
  return mode === "notifications" || mode === "notifications-and-sound";
}

const TAG_HASH_OFFSET_BASIS = 0xcbf29ce484222325n;
const TAG_HASH_PRIME = 0x100000001b3n;
const TAG_HASH_MASK = 0xffffffffffffffffn;

/** Windows drops toast notifications whose tag is as long as an environment and thread id. */
function notificationTag(key: string): string {
  let hash = TAG_HASH_OFFSET_BASIS;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= BigInt(key.charCodeAt(index));
    hash = (hash * TAG_HASH_PRIME) & TAG_HASH_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

export function threadNotificationTag(environmentId: EnvironmentId, threadId: ThreadId): string {
  return notificationTag(`${environmentId}:${threadId}`);
}

export interface ThreadNotificationApp {
  readonly appId: AppId;
  readonly name: string;
}

/** The app that owns a thread's project; the name falls back to the id when no status is readable. */
export function threadNotificationApp(
  project: { readonly appBinding?: AppBinding | undefined } | undefined,
  apps: ReadonlyArray<{ readonly appId: AppId; readonly name: string }>,
): ThreadNotificationApp | null {
  const appId = project?.appBinding?.appId;
  if (appId === undefined) return null;
  return { appId, name: apps.find((app) => app.appId === appId)?.name ?? appId };
}

export function threadNotificationTitle(title: string, app: ThreadNotificationApp | null): string {
  return app === null ? title : `${app.name}: ${title}`;
}

/**
 * Projects mode hides app threads, so opening one from an alert also brings its app up in
 * the sidebar; otherwise the open thread would have no row there.
 */
export function revealNotifiedAppThread(app: ThreadNotificationApp | null) {
  if (app === null) return;
  const ui = useUiStateStore.getState();
  if (ui.sidebarMode === "apps" && ui.sidebarAppScopeKey === app.appId) return;
  // A selection made in one mode holds rows the other mode does not show.
  useThreadSelectionStore.getState().clearSelection();
  ui.setSidebarMode("apps");
  ui.setSidebarAppScopeKey(app.appId);
}

let originalFavicon: HTMLLinkElement | undefined;
let badgeFavicon: HTMLLinkElement | undefined;

export function setNotificationBadge(count: number) {
  const bridge = window.desktopBridge;
  let image: string | null = null;
  if (count > 0 && (!bridge || bridge.getClientPlatform?.() === "win32")) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#e5484d";
      context.beginPath();
      context.arc(32, 32, 28, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "white";
      context.font = `600 ${count > 9 ? 30 : 40}px "Segoe UI", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(count > 9 ? "9+" : String(count), 32, 34);
      image = canvas.toDataURL("image/png");
    }
  }
  if (!bridge) {
    if (image) {
      if (!badgeFavicon) {
        originalFavicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? undefined;
        badgeFavicon = document.createElement("link");
        badgeFavicon.rel = "icon";
        badgeFavicon.type = "image/png";
        badgeFavicon.sizes.value = "64x64";
        originalFavicon?.remove();
        document.head.append(badgeFavicon);
      }
      badgeFavicon.href = image;
    } else if (badgeFavicon) {
      badgeFavicon.remove();
      badgeFavicon = undefined;
      if (originalFavicon) document.head.append(originalFavicon);
      originalFavicon = undefined;
    }
  }
  void bridge?.setNotificationBadge?.({ count, image }).catch(() => undefined);
}

let audioContext: AudioContext | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();
/** When each sound's current playback ends, on the audio context's clock. */
const playingUntil = new Map<string, number>();

/** Called from a gesture so browsers allow later background playback. */
export function unlockNotificationAudio() {
  audioContext ??= new AudioContext();
  void audioContext.resume().catch(() => undefined);
}

export async function playNotificationSound(
  kind: "completion" | "input",
  shouldPlay: () => boolean,
) {
  if (!audioContext || audioContext.state !== "running") return;
  const context = audioContext;
  const url = kind === "completion" ? completionUrl : inputUrl;
  try {
    let buffer = buffers.get(url);
    if (!buffer) {
      buffer = fetch(url)
        .then((response) => response.arrayBuffer())
        .then((data) => context.decodeAudioData(data));
      buffers.set(url, buffer);
    }
    const decoded = await buffer;
    if (!shouldPlay() || context.state !== "running") return;
    // Coalesce same-sound bursts after decode to avoid clipping; input and completion alerts keep separate slots.
    if (context.currentTime < (playingUntil.get(url) ?? 0)) return;
    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(context.destination);
    source.start();
    playingUntil.set(url, context.currentTime + decoded.duration);
  } catch {
    buffers.delete(url);
  }
}

// ── Squire notification intents ───────────────────────────────

export interface SquireNotificationIntent {
  readonly squireId: SquireId;
  /** The `notification.pushed` log row's sequence; one notification per intent. */
  readonly sequence: number;
  readonly title: string;
  readonly body: string;
}

/**
 * New `notification.pushed` intents since `seen`, the last intent sequence per Squire. The first
 * look at an environment only records where it stands, so a reload never replays old intents.
 */
export function squireNotificationIntents(
  seen: ReadonlyMap<SquireId, number> | null,
  state: SquireEnvironmentState,
): { readonly seen: ReadonlyMap<SquireId, number>; readonly intents: SquireNotificationIntent[] } {
  const nextSeen = new Map<SquireId, number>();
  const intents: SquireNotificationIntent[] = [];
  for (const entry of state.squires) {
    const pushed = entry.recentActivity
      .filter((activity) => activity.kind === "notification.pushed")
      .map((activity) => activity.sequence)
      .toSorted((left, right) => left - right);
    // A Squire created after the first look has no mark yet, so all of its intents are new.
    const last = seen === null ? Number.POSITIVE_INFINITY : (seen.get(entry.squire.id) ?? -1);
    nextSeen.set(entry.squire.id, Math.max(seen?.get(entry.squire.id) ?? -1, ...pushed));
    // The server writes no intent while Notify is Off; this covers a toggle that lands between
    // the write and this snapshot.
    if (entry.squire.permissions.notify === "off") continue;
    const count = entry.openDecisionCount;
    const body =
      count === 0
        ? "New update"
        : count === 1
          ? "1 item waits on you"
          : `${count} items wait on you`;
    for (const sequence of pushed) {
      if (sequence > last) {
        intents.push({ squireId: entry.squire.id, sequence, title: entry.squire.name, body });
      }
    }
  }
  return { seen: nextSeen, intents };
}

export function squireNotificationTag(environmentId: EnvironmentId, squireId: SquireId): string {
  return notificationTag(`${environmentId}:squire:${squireId}`);
}

/**
 * Tells the server a shown intent was `alerted` on this desktop. The snapshot names an
 * intent only by its log sequence, so its card comes from the `notification.pushed` log row.
 */
export async function reportSquireAlert(
  intent: Pick<SquireNotificationIntent, "sequence">,
  deps: {
    readonly readLog: () => Promise<ReadonlyArray<
      Pick<SquireActionLogEntry, "id" | "kind" | "cardId">
    > | null>;
    readonly report: (cardId: SquireCardId) => Promise<unknown>;
  },
): Promise<boolean> {
  const entries = await deps.readLog();
  const cardId = entries?.find(
    (entry) => entry.id === intent.sequence && entry.kind === "notification.pushed",
  )?.cardId;
  if (cardId == null) return false;
  await deps.report(cardId);
  return true;
}
