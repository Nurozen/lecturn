// @effect-diagnostics globalTimers:off globalDate:off -- The isolated notch has no Effect runtime; one 1 Hz interval runs only while a hold exists, and one timeout waits for the next result expiry.
import type {
  DesktopActivityRow,
  DesktopActivitySquireActionKind,
  DesktopActivitySquireResult,
} from "@lecturn/contracts";

/** A row the notch renders in its "SQUIRE" section rather than as a thread or PR card. */
export type SquireActivityRow = DesktopActivityRow & {
  readonly squire: NonNullable<DesktopActivityRow["squire"]>;
};

export function isSquireActivityRow(row: DesktopActivityRow): row is SquireActivityRow {
  return row.squire !== undefined;
}

export function isSquireActionKind(
  id: DesktopActivityRow["actions"][number]["id"],
): id is DesktopActivitySquireActionKind {
  return id.startsWith("squire-");
}

/** The small Threadkeeper mark, inline because the notch's CSP allows no remote images. */
export const threadkeeperSmallMark = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" aria-hidden="true" viewBox="0 0 24 24" fill="none">
  <g stroke-linecap="round" stroke-linejoin="round" stroke-width="1.25">
    <path stroke="#dfc7a4" d="M16 4C9 2 5 6 7 9C9 12 19 11 19 16C19 20 14 22 9 20"/>
    <path stroke="#d9a34e" d="M4.5 12C4.5 16 11 15.5 14 17C17 19 13 21 9 20"/>
  </g>
  <g fill="#d9a34e">
    <circle cx="4.5" cy="12" r="1"/>
    <circle cx="9" cy="20" r="1"/>
    <path d="M16 1.5C16.3 3.4 16.6 3.7 18.5 4C16.6 4.3 16.3 4.6 16 6.5C15.7 4.6 15.4 4.3 13.5 4C15.4 3.7 15.7 3.4 16 1.5Z"/>
  </g>
</svg>`;

/** `open` opens the card's target thread; every other button is a Squire action. */
export type SquireCardButtonKind = DesktopActivitySquireActionKind | "open";

export interface SquireCardButton {
  readonly kind: SquireCardButtonKind;
  readonly label: string;
  readonly primary: boolean;
  readonly disabled: boolean;
}

/** Everything a notch Squire card shows; no logo on cards. */
export interface SquireCardView {
  readonly title: string;
  readonly subtitle: string;
  readonly status: string;
  readonly excerpt: string | null;
  /** Origin and rule labels, e.g. "Auto by rule: …". */
  readonly labels: ReadonlyArray<string>;
  readonly caption: string | null;
  /** Present on a held row: what remained when the snapshot arrived. */
  readonly holdRemainingMs: number | null;
  /** The row publishes its buttons in card order: the primary, then Dismiss, then Open. */
  readonly buttons: ReadonlyArray<SquireCardButton>;
  /**
   * An open card with a newer hold of its kind beside it. The hold's countdown and Undo
   * show on this line under the card instead of as a second card with the same title.
   */
  readonly heldLine: {
    readonly label: string;
    readonly remainingMs: number;
    readonly ruleLabel: string | null;
    readonly undo: SquireCardButton | null;
  } | null;
  /** The outcome of the last press on this card, shown on it until it clears or is dismissed. */
  readonly result: SquireResult | null;
}

export function squireCardView(
  row: SquireActivityRow,
  pending: boolean,
  result: SquireResult | null = null,
): SquireCardView {
  const { heldOver } = row.squire;
  const buttons: SquireCardButton[] = [];
  // A paired hold's Undo belongs on its line, wherever the row lists it, and is never primary.
  let undo: SquireCardButton | null = null;
  for (const action of row.actions) {
    if (!isSquireActionKind(action.id) && action.id !== "open") continue;
    const disabled = pending || action.disabled === true;
    if (heldOver !== undefined && action.id === "squire-undo") {
      undo ??= { kind: action.id, label: action.label, primary: false, disabled };
      continue;
    }
    buttons.push({
      kind: action.id,
      label: action.label,
      // A card's first button is its primary unless the card offers only Dismiss.
      primary: buttons.length === 0 && action.id !== "squire-dismiss",
      disabled,
    });
  }
  return {
    title: row.title,
    subtitle: row.subtitle,
    status: row.status,
    excerpt: row.excerpt || null,
    labels: row.detail?.split("\n").filter((label) => label.trim()) ?? [],
    caption: row.squire.caption || null,
    holdRemainingMs: row.squire.holdRemainingMs ?? null,
    buttons,
    heldLine:
      heldOver === undefined
        ? null
        : {
            label: heldOver.label,
            remainingMs: heldOver.remainingMs,
            ruleLabel: heldOver.ruleLabel || null,
            undo,
          },
    result,
  };
}

export type SquireResultKind = "success" | "info" | "error";

/**
 * What a press came to: a success; info for an outcome that is not a failure (already settled,
 * outdated, gone); or an error for a refusal with a reason or a transport failure.
 */
export interface SquireResult {
  readonly rowId: string;
  readonly kind: SquireResultKind;
  readonly text: string;
  /** The card's title, so the result still reads once the card is gone. */
  readonly title: string;
  /** When it arrived; its expiry counts from here. */
  readonly at: number;
}

/**
 * The contract carries only `ok` and a message, so the bridge sends an info outcome as `ok`
 * with a message: nothing failed, and the message says why nothing happened.
 */
export function squireResultKind(
  result: Pick<DesktopActivitySquireResult, "ok" | "error">,
): SquireResultKind {
  if (!result.ok) return "error";
  return result.error ? "info" : "success";
}

/**
 * What a press shows once the server confirms it; null for Open, which hands off to Lecturn.
 * An offer's Not now saves nothing and settles no item, so it says so as info rather than
 * reading like a dismissal or a saved rule.
 */
export function squirePressSuccess(
  row: Pick<SquireActivityRow, "status">,
  kind: DesktopActivitySquireActionKind,
): { readonly kind: SquireResultKind; readonly text: string } | null {
  const offer = row.status === "Rule offer";
  if (kind === "squire-accept") return { kind: "success", text: offer ? "Rule saved." : "Sent." };
  if (kind === "squire-dismiss") {
    return offer
      ? { kind: "info", text: "No rule saved." }
      : { kind: "success", text: "Dismissed." };
  }
  if (kind === "squire-undo") return { kind: "success", text: "Undone." };
  return null;
}

export const SQUIRE_RESULT_CLEAR_MS = 4_000;
export const SQUIRE_TOAST_CLEAR_MS = 10_000;
const SQUIRE_TOAST_LIMIT = 2;

/**
 * When a result clears: on its card, a success or info after 4 s and an error never (it waits
 * for a dismissal or the card's next press); as a toast once its card is gone, after 10 s.
 */
function squireResultExpiry(result: SquireResult, onCard: boolean): number | null {
  if (!onCard) return result.at + SQUIRE_TOAST_CLEAR_MS;
  return result.kind === "error" ? null : result.at + SQUIRE_RESULT_CLEAR_MS;
}

export type SquireResultEvent =
  /** A newer result replaces the card's older one. */
  | { readonly type: "record"; readonly result: SquireResult }
  /** The card's next press, its Open, or the result's dismiss. */
  | { readonly type: "clear"; readonly rowId: string }
  /** A render or a timer: drops what expired and keeps the newest distinct toasts. */
  | { readonly type: "sync"; readonly now: number };

/** Oldest first. `cardIds` are the rows the notch shows a card for. */
export function reduceSquireResults(
  results: ReadonlyArray<SquireResult>,
  event: SquireResultEvent,
  cardIds: ReadonlySet<string>,
): ReadonlyArray<SquireResult> {
  if (event.type === "clear") return results.filter((result) => result.rowId !== event.rowId);
  if (event.type === "record")
    return reduceSquireResults(
      [...results.filter((result) => result.rowId !== event.result.rowId), event.result],
      { type: "sync", now: event.result.at },
      cardIds,
    );
  const toastTexts = new Set<string>();
  const kept: SquireResult[] = [];
  for (const result of results.toReversed()) {
    const onCard = cardIds.has(result.rowId);
    const expiry = squireResultExpiry(result, onCard);
    if (expiry !== null && expiry <= event.now) continue;
    if (!onCard) {
      if (toastTexts.size === SQUIRE_TOAST_LIMIT || toastTexts.has(result.text)) continue;
      toastTexts.add(result.text);
    }
    kept.push(result);
  }
  return kept.toReversed();
}

export interface SquireResultTimers {
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
}

const defaultResultTimers: SquireResultTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
  now: () => Date.now(),
};

/**
 * The notch's results, through `reduceSquireResults`. One timeout waits for the next expiry and
 * tells the notch which nodes to remove, never a render.
 */
export class SquireResults {
  private results: ReadonlyArray<SquireResult> = [];
  private cardIds: ReadonlySet<string> = new Set();
  private timeout: { readonly handle: unknown; readonly at: number } | undefined;
  private readonly onExpire: (rowId: string) => void;
  private readonly timers: SquireResultTimers;

  constructor(onExpire: (rowId: string) => void, timers: SquireResultTimers = defaultResultTimers) {
    this.onExpire = onExpire;
    this.timers = timers;
  }
  record(result: Omit<SquireResult, "at">): void {
    this.apply({ type: "record", result: { ...result, at: this.timers.now() } });
  }
  /** A new press or a dismissal; the caller removes the node. */
  clear(rowId: string): void {
    this.apply({ type: "clear", rowId });
  }
  /** Before a render, with the rows it shows a card for. */
  sync(cardIds: ReadonlySet<string>): ReadonlyArray<SquireResult> {
    this.cardIds = cardIds;
    this.apply({ type: "sync", now: this.timers.now() });
    return this.results;
  }
  get(rowId: string): SquireResult | null {
    return this.results.find((result) => result.rowId === rowId) ?? null;
  }
  all(): ReadonlyArray<SquireResult> {
    return this.results;
  }
  private apply(event: SquireResultEvent): void {
    this.results = reduceSquireResults(this.results, event, this.cardIds);
    this.schedule();
  }
  private schedule(): void {
    let next: number | null = null;
    for (const result of this.results) {
      const expiry = squireResultExpiry(result, this.cardIds.has(result.rowId));
      if (expiry !== null && (next === null || expiry < next)) next = expiry;
    }
    if (this.timeout?.at === next) return;
    if (this.timeout !== undefined) this.timers.clearTimeout(this.timeout.handle);
    this.timeout = undefined;
    if (next === null) return;
    const at = next;
    this.timeout = {
      at,
      handle: this.timers.setTimeout(
        () => {
          this.timeout = undefined;
          const before = this.results;
          this.apply({ type: "sync", now: Math.max(at, this.timers.now()) });
          for (const result of before)
            if (!this.results.includes(result)) this.onExpire(result.rowId);
        },
        Math.max(0, at - this.timers.now()),
      ),
    };
  }
}

/**
 * The notch's "SQUIRE" section: its cards, and results whose card is gone as toast rows, newest
 * first. Null when there is neither, so the header shows exactly when the section has something.
 */
export function squireSection(
  rows: ReadonlyArray<DesktopActivityRow>,
  results: ReadonlyArray<SquireResult>,
): {
  readonly cards: ReadonlyArray<SquireActivityRow>;
  readonly toasts: ReadonlyArray<SquireResult>;
} | null {
  const cards = rows.filter(isSquireActivityRow);
  const toasts = results
    .filter((result) => !cards.some((card) => card.id === result.rowId))
    .toReversed();
  return cards.length === 0 && toasts.length === 0 ? null : { cards, toasts };
}

/**
 * The empty state belongs to an empty notch: never above Squire cards or toasts. The count is
 * every published row, Squire cards included.
 */
export function activityListState(
  rows: ReadonlyArray<DesktopActivityRow>,
  section: ReturnType<typeof squireSection>,
): { readonly count: number; readonly empty: boolean } {
  return { count: rows.length, empty: rows.length === 0 && section === null };
}

export function squireCountdownText(remainingMs: number, label?: string): string {
  const seconds = Math.ceil(remainingMs / 1000);
  if (label === undefined) return remainingMs > 0 ? `Sending in ${seconds}s` : "Sending now";
  return `${label} · ${remainingMs > 0 ? `sending in ${seconds}s` : "sending now"}`;
}

export interface SquireCountdownTimers {
  readonly setInterval: (callback: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly now: () => number;
}

export interface SquireCountdownEntry {
  readonly node: { textContent: string | null };
  readonly holdRemainingMs: number;
  /** A paired hold's line, e.g. "Newer steer held", read before the countdown. */
  readonly label?: string;
}

const defaultTimers: SquireCountdownTimers = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as Parameters<typeof globalThis.clearInterval>[0]),
  now: () => Date.now(),
};

/**
 * Patches countdown text nodes once a second. It never rebuilds the notch, and its
 * interval exists only while some hold has time left.
 */
export class SquireCountdown {
  private readonly timers: SquireCountdownTimers;
  private entries: ReadonlyArray<SquireCountdownEntry> = [];
  private receivedAt = 0;
  private handle: unknown = undefined;

  constructor(timers: SquireCountdownTimers = defaultTimers) {
    this.timers = timers;
  }
  /** Replaces the tracked nodes after a render; `receivedAt` is when their snapshot arrived. */
  sync(entries: ReadonlyArray<SquireCountdownEntry>, receivedAt: number): void {
    this.entries = entries;
    this.receivedAt = receivedAt;
    if (this.tick() && this.handle === undefined)
      this.handle = this.timers.setInterval(() => this.tick(), 1000);
  }
  get running(): boolean {
    return this.handle !== undefined;
  }
  dispose(): void {
    this.entries = [];
    this.stop();
  }
  /** True while some hold still has time left. */
  private tick(): boolean {
    const now = this.timers.now();
    let live = false;
    for (const entry of this.entries) {
      // Same formula as client-runtime's holdRemaining, inlined because the sandboxed preload
      // must not pull in that module's RPC and Effect graph.
      const remaining = Math.min(
        entry.holdRemainingMs,
        Math.max(0, this.receivedAt + entry.holdRemainingMs - now),
      );
      if (remaining > 0) live = true;
      const text = squireCountdownText(remaining, entry.label);
      if (entry.node.textContent !== text) entry.node.textContent = text;
    }
    if (!live) this.stop();
    return live;
  }
  private stop(): void {
    if (this.handle === undefined) return;
    this.timers.clearInterval(this.handle);
    this.handle = undefined;
  }
}

export interface SquireSettledRequest {
  readonly rowId: string;
  readonly kind: DesktopActivitySquireActionKind;
  readonly result: SquireResultKind;
  readonly message: string;
}

/**
 * A v4 UUID from `getRandomValues`: the notch is a `data:` document, not a secure context, so
 * `crypto.randomUUID` does not exist there.
 */
function squireRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Matches the renderer's RPC outcome to the press that asked for it. */
export class SquireRequests {
  private readonly makeId: () => string;
  private readonly pending = new Map<
    string,
    { readonly rowId: string; readonly kind: DesktopActivitySquireActionKind }
  >();

  constructor(makeId: () => string = squireRequestId) {
    this.makeId = makeId;
  }
  begin(rowId: string, kind: DesktopActivitySquireActionKind): string {
    const requestId = this.makeId();
    this.pending.set(requestId, { rowId, kind });
    return requestId;
  }
  isPending(rowId: string): boolean {
    for (const request of this.pending.values()) if (request.rowId === rowId) return true;
    return false;
  }
  /** Null for an unknown or already settled request. */
  settle(result: DesktopActivitySquireResult): SquireSettledRequest | null {
    const request = this.pending.get(result.requestId);
    if (!request) return null;
    this.pending.delete(result.requestId);
    return {
      ...request,
      result: squireResultKind(result),
      message: result.error ?? (result.ok ? "" : "The Squire action failed."),
    };
  }
  /** The host refused to forward it, so no result will come. */
  abandon(requestId: string): void {
    this.pending.delete(requestId);
  }
}
