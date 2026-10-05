import { activityVisualState } from "@lecturn/client-runtime/state/activityContext";
import type {
  ActivityVisualState,
  DesktopActivitySnapshot,
  DesktopActivityRow,
} from "@lecturn/contracts";
import type { ActivityChange } from "./changes.ts";
import { isViewedActivityThread } from "./interaction.ts";

/** Main-process revision makes asynchronous panel requests expire with their snapshot. */
export type ActivityPanelSnapshot = DesktopActivitySnapshot & { revision: number };
export type ActivityAnnouncement = { change: ActivityChange; revision: number };

export function isCurrentActivityAnnouncement(
  announcement: ActivityAnnouncement,
  snapshot: ActivityPanelSnapshot,
): boolean {
  if (announcement.revision !== snapshot.revision) return false;
  const row = snapshot.rows.find((entry) => entry.id === announcement.change.rowId);
  return Boolean(
    row &&
    (snapshot.readyEnvironmentIds === undefined ||
      snapshot.readyEnvironmentIds.includes(row.environmentId)) &&
    !isViewedActivityThread(row, snapshot.viewedThread),
  );
}

/** Matches the web client's 45s interaction window for background activity reporting. */
export const ACTIVITY_PRESENCE_IDLE_SECONDS = 45;

/** The user is looking at Lecturn: alerts from the notch would only repeat what is on screen. */
export function isUserPresent(input: {
  visible: boolean;
  focused: boolean;
  idleSeconds: number;
}): boolean {
  return input.visible && input.focused && input.idleSeconds < ACTIVITY_PRESENCE_IDLE_SECONDS;
}

// Ordered by urgency. Starts and idles are stale news by the time the user looks away.
const deferrable: readonly ActivityVisualState[] = ["attention", "failed", "complete"];

const changeKey = (change: ActivityChange) =>
  JSON.stringify([change.rowId, change.check?.name ?? null]);
const stillCurrent = (change: ActivityChange, row: DesktopActivityRow) => {
  const expected = change.check;
  return expected
    ? Boolean(
        row.watchId &&
        row.checks?.some(
          (check) => check.name === expected.name && check.status === expected.status,
        ),
      )
    : (row.visualState ?? activityVisualState(row)) === change.state;
};

/** Decides whether the notch may alert for a change now, and holds what it silenced
 * until presence ends. Only user-facing alerts pass through here; hover and click
 * expansion never do. */
export class ActivityAttentionGate {
  private readonly held = new Map<string, ActivityChange>();

  get holding(): boolean {
    return this.held.size > 0;
  }

  /** True when the alert should fire immediately. */
  offer(change: ActivityChange, present: boolean): boolean {
    const key = changeKey(change);
    this.held.delete(key);
    if (!present) return true;
    if (deferrable.includes(change.state)) this.held.set(key, change);
    return false;
  }

  /** Call with every published snapshot, before its viewed thread is hidden from the
   * panel. A held alert is spent the moment the user opens that thread, even if they
   * move on to another one before looking away. */
  observe(snapshot: DesktopActivitySnapshot): void {
    const rows = new Map(snapshot.rows.map((row) => [row.id, row]));
    for (const [id, change] of this.held) {
      const row = rows.get(change.rowId);
      if (
        !row ||
        (snapshot.readyEnvironmentIds !== undefined &&
          !snapshot.readyEnvironmentIds.includes(row.environmentId)) ||
        isViewedActivityThread(row, snapshot.viewedThread) ||
        !stillCurrent(change, row)
      )
        this.held.delete(id);
    }
  }

  /** Call once presence has ended. Returns the most urgent held alert whose row is
   * still in that state, and forgets the rest so nothing fires twice. */
  release(snapshot: DesktopActivitySnapshot): ActivityChange | undefined {
    this.observe(snapshot);
    const current = [...this.held.values()];
    this.held.clear();
    return current.toSorted(
      (left, right) => deferrable.indexOf(left.state) - deferrable.indexOf(right.state),
    )[0];
  }

  clear(): void {
    this.held.clear();
  }
}
