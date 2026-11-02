import { describe, expect, it, vi } from "vite-plus/test";
import { SquireCardId, SquireId } from "@lecturn/contracts";
import {
  SQUIRE_RESULT_CLEAR_MS,
  SQUIRE_TOAST_CLEAR_MS,
  SquireCountdown,
  SquireRequests,
  SquireResults,
  activityListState,
  isSquireActivityRow,
  reduceSquireResults,
  squireCardView,
  squireCountdownText,
  squirePressSuccess,
  squireResultKind,
  squireSection,
  type SquireActivityRow,
  type SquireResult,
} from "./squire.ts";
import { activityDocument } from "./document.ts";
import { activityThemeStyles } from "./theme.ts";

const held: SquireActivityRow = {
  id: JSON.stringify(["env", "squire", "card-1"]),
  environmentId: "env",
  projectId: "project",
  threadId: "thread",
  title: "Rerun the failing api-e2e job",
  subtitle: "Release",
  status: "Held",
  detail: "Auto by rule: Release may auto-send rerun checks steers on threads in billing",
  squire: {
    squireId: SquireId.make("squire-1"),
    cardId: SquireCardId.make("card-1"),
    cardKind: "steer",
    palette: "brass",
    holdRemainingMs: 42_000,
  },
  actions: [
    { id: "squire-undo", label: "Undo" },
    { id: "squire-open", label: "Open" },
  ],
};

function fakeTimers(start = 1_000) {
  let now = start;
  let callback: (() => void) | null = null;
  let intervals = 0;
  return {
    timers: {
      setInterval: (next: () => void) => {
        intervals += 1;
        callback = next;
        return intervals;
      },
      clearInterval: () => {
        callback = null;
      },
      now: () => now,
    },
    advance(ms: number) {
      for (let step = 0; step < ms / 1000; step += 1) {
        now += 1000;
        callback?.();
      }
    },
    get active() {
      return callback !== null;
    },
    get intervals() {
      return intervals;
    },
  };
}

describe("notch Squire rows", () => {
  it("recognizes only rows that carry a Squire card", () => {
    expect(isSquireActivityRow(held)).toBe(true);
    const { squire: _squire, ...thread } = held;
    expect(isSquireActivityRow(thread)).toBe(false);
  });

  it("shows the held countdown, rule labels, and Undo, and disables buttons while pending", () => {
    const view = squireCardView(held, false);
    expect(view.holdRemainingMs).toBe(42_000);
    expect(view.labels).toEqual([held.detail]);
    expect(view.buttons.map((button) => button.kind)).toEqual(["squire-undo", "squire-open"]);
    expect(squireCardView(held, true).buttons.every((button) => button.disabled)).toBe(true);
  });

  it("reads seconds left, then now", () => {
    expect(squireCountdownText(42_000)).toBe("Sending in 42s");
    expect(squireCountdownText(1)).toBe("Sending in 1s");
    expect(squireCountdownText(0)).toBe("Sending now");
    expect(squireCountdownText(52_000, "Newer steer held")).toBe(
      "Newer steer held · sending in 52s",
    );
  });

  it("puts a paired hold's countdown and Undo on a line under its open card (P7.6)", () => {
    const { holdRemainingMs: _hold, ...open } = held.squire;
    const paired: SquireActivityRow = {
      ...held,
      status: "Steer · Rebase",
      squire: {
        ...open,
        caption: "A newer steer is about to send",
        heldOver: {
          heldCardId: SquireCardId.make("held-2"),
          label: "Newer steer held",
          remainingMs: 52_000,
          ruleLabel: "Auto by rule: Release may auto-send rebase steers",
        },
      },
      // The line reads `heldOver`, not the order of the buttons.
      actions: [
        { id: "squire-undo", label: "Undo" },
        { id: "squire-accept", label: "Send" },
        { id: "squire-dismiss", label: "Dismiss" },
        { id: "squire-open", label: "Open" },
      ],
    };
    const view = squireCardView(paired, false);
    expect(view.holdRemainingMs).toBeNull();
    expect(view.buttons.map((button) => button.kind)).toEqual([
      "squire-accept",
      "squire-dismiss",
      "squire-open",
    ]);
    expect(view.buttons[0]!.primary).toBe(true);
    expect(view.heldLine).toMatchObject({
      label: "Newer steer held",
      remainingMs: 52_000,
      ruleLabel: "Auto by rule: Release may auto-send rebase steers",
      undo: { kind: "squire-undo" },
    });
    // A held row of its own keeps its Undo among its buttons and has no paired line.
    expect(squireCardView(held, false).heldLine).toBeNull();
    expect(squireCardView(held, false).buttons[0]!.kind).toBe("squire-undo");
  });
});

describe("notch Squire press outcomes", () => {
  it("says an offer's Not now saved nothing, as info, while a card's Dismiss dismisses", () => {
    const offer = { status: "Rule offer" };
    expect(squirePressSuccess(offer, "squire-dismiss")).toEqual({
      kind: "info",
      text: "No rule saved.",
    });
    expect(squirePressSuccess(offer, "squire-accept")).toEqual({
      kind: "success",
      text: "Rule saved.",
    });
    expect(squirePressSuccess(held, "squire-dismiss")).toEqual({
      kind: "success",
      text: "Dismissed.",
    });
    expect(squirePressSuccess(held, "squire-open")).toBeNull();
  });
});

describe("notch Squire countdown", () => {
  it("patches only its text nodes once a second and stops when the hold runs out", () => {
    const clock = fakeTimers();
    const render = vi.fn();
    const node = { textContent: "" as string | null };
    const countdown = new SquireCountdown(clock.timers);
    countdown.sync([{ node, holdRemainingMs: 3_000 }], clock.timers.now());
    expect(node.textContent).toBe("Sending in 3s");
    clock.advance(1_000);
    expect(node.textContent).toBe("Sending in 2s");
    clock.advance(2_000);
    expect(node.textContent).toBe("Sending now");
    expect(clock.active).toBe(false);
    expect(countdown.running).toBe(false);
    expect(render).not.toHaveBeenCalled();
  });

  it("runs no interval without a hold and keeps one interval across renders", () => {
    const clock = fakeTimers();
    const countdown = new SquireCountdown(clock.timers);
    countdown.sync([], clock.timers.now());
    expect(clock.intervals).toBe(0);
    countdown.sync([{ node: { textContent: "" }, holdRemainingMs: 10_000 }], clock.timers.now());
    countdown.sync([{ node: { textContent: "" }, holdRemainingMs: 9_000 }], clock.timers.now());
    expect(clock.intervals).toBe(1);
    countdown.sync([], clock.timers.now());
    expect(clock.active).toBe(false);
    countdown.dispose();
  });
});

describe("notch Squire requests", () => {
  it("settles the press that sent the request, once", () => {
    let next = 0;
    const requests = new SquireRequests(() => `request-${++next}`);
    const requestId = requests.begin(held.id, "squire-undo");
    expect(requests.isPending(held.id)).toBe(true);
    expect(requests.settle({ requestId: "other", ok: true })).toBeNull();
    expect(requests.settle({ requestId, ok: false, error: "Already executed" })).toEqual({
      rowId: held.id,
      kind: "squire-undo",
      result: "error",
      message: "Already executed",
    });
    expect(requests.isPending(held.id)).toBe(false);
    expect(requests.settle({ requestId, ok: true })).toBeNull();
  });
});

describe("notch Squire request ids", () => {
  // The notch is a data: document, not a secure context, so crypto.randomUUID is absent there.
  it("makes a valid request id for a press without crypto.randomUUID", () => {
    const { getRandomValues } = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: getRandomValues.bind(globalThis.crypto) });
    try {
      const requests = new SquireRequests();
      const first = requests.begin(held.id, "squire-undo");
      const second = requests.begin(held.id, "squire-undo");
      for (const id of [first, second])
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(first).not.toBe(second);
      expect(requests.settle({ requestId: first, ok: true })).toMatchObject({ rowId: held.id });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const question: SquireActivityRow = {
  ...held,
  id: JSON.stringify(["env", "squire", "card-2"]),
  title: "Should the catalog ship offline-only?",
  status: "Question",
  squire: { ...held.squire, cardId: SquireCardId.make("card-2"), cardKind: "question" },
  actions: [
    { id: "squire-open", label: "Answer" },
    { id: "squire-dismiss", label: "Dismiss" },
    { id: "open", label: "Open" },
  ],
};

describe("notch Squire card buttons", () => {
  it("fills only the first button, so every card reads primary, Dismiss, Open", () => {
    expect(
      squireCardView(question, false).buttons.map((button) => [button.label, button.primary]),
    ).toEqual([
      ["Answer", true],
      ["Dismiss", false],
      ["Open", false],
    ]);
    const okOnly = { ...question, actions: [{ id: "squire-dismiss" as const, label: "OK" }] };
    expect(squireCardView(okOnly, false).buttons[0]!.primary).toBe(false);
  });
});

function fakeTimeouts(start = 1_000) {
  let now = start;
  const pending = new Map<number, { readonly at: number; readonly callback: () => void }>();
  let next = 0;
  return {
    timers: {
      setTimeout: (callback: () => void, ms: number) => {
        pending.set(++next, { at: now + ms, callback });
        return next;
      },
      clearTimeout: (handle: unknown) => pending.delete(handle as number),
      now: () => now,
    },
    /** Moves the clock, firing what falls due, as the notch's one timeout would. */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending].filter(([, entry]) => entry.at <= until);
        if (due.length === 0) break;
        const [handle, entry] = due.toSorted((a, b) => a[1].at - b[1].at)[0]!;
        pending.delete(handle);
        now = entry.at;
        entry.callback();
      }
      now = until;
    },
    get count() {
      return pending.size;
    },
  };
}

const at = (result: Omit<SquireResult, "at">, time = 0): SquireResult => ({ ...result, at: time });

describe("notch Squire result kinds", () => {
  it("reads success, info, and error from the relayed result", () => {
    expect(squireResultKind({ ok: true })).toBe("success");
    expect(squireResultKind({ ok: true, error: "This item was dismissed." })).toBe("info");
    expect(squireResultKind({ ok: false, error: "Release is paused." })).toBe("error");
    const requests = new SquireRequests(() => "request-1");
    requests.begin(held.id, "squire-accept");
    expect(
      requests.settle({ requestId: "request-1", ok: true, error: "This item is outdated." }),
    ).toMatchObject({ result: "info", message: "This item is outdated." });
  });
});

describe("notch Squire results", () => {
  const onCard = new Set([held.id, question.id]);

  it("keeps one result per card, so a later success replaces that card's error", () => {
    let results = reduceSquireResults(
      [],
      {
        type: "record",
        result: at({
          rowId: held.id,
          kind: "error",
          text: "Could not act on the items. Try again.",
          title: held.title,
        }),
      },
      onCard,
    );
    results = reduceSquireResults(
      results,
      {
        type: "record",
        result: at({ rowId: held.id, kind: "success", text: "Undone.", title: held.title }, 500),
      },
      onCard,
    );
    expect(results.map((result) => [result.kind, result.text])).toEqual([["success", "Undone."]]);
    expect(squireSection([held], results)?.toasts).toEqual([]);
  });

  it("clears a card's error on its next press, and never on a timer", () => {
    const error = at({ rowId: held.id, kind: "error", text: "Release is paused.", title: "" });
    const results = reduceSquireResults([], { type: "record", result: error }, onCard);
    expect(reduceSquireResults(results, { type: "sync", now: 3_600_000 }, onCard)).toEqual([error]);
    expect(reduceSquireResults(results, { type: "clear", rowId: held.id }, onCard)).toEqual([]);
  });

  it("shows only the newest two distinct toasts once their cards are gone", () => {
    const gone = (rowId: string, text: string, time: number) =>
      at({ rowId, kind: "info", text, title: "billing-service #321" }, time);
    let results: ReadonlyArray<SquireResult> = [];
    for (const result of [
      at(
        { rowId: "a", kind: "error", text: "Could not act on the items. Try again.", title: "" },
        0,
      ),
      gone("b", "This item was dismissed.", 100),
      gone("c", "This item was dismissed.", 200),
      gone("d", "This item is no longer available. Refresh activity in Lecturn.", 300),
    ])
      results = reduceSquireResults(results, { type: "record", result }, new Set());
    expect(squireSection([], results)?.toasts.map((toast) => [toast.rowId, toast.text])).toEqual([
      ["d", "This item is no longer available. Refresh activity in Lecturn."],
      ["c", "This item was dismissed."],
    ]);
  });

  it("clears an on-card success or info after 4 s and any toast after 10 s, by patching", () => {
    const clock = fakeTimeouts();
    const expired: string[] = [];
    const results = new SquireResults((rowId) => expired.push(rowId), clock.timers);
    results.sync(onCard);
    results.record({ rowId: held.id, kind: "success", text: "Undone.", title: held.title });
    results.record({ rowId: question.id, kind: "error", text: "Release is paused.", title: "" });
    results.record({
      rowId: "offer",
      kind: "success",
      text: "Rule saved.",
      title: "Always ask first",
    });
    expect(clock.count).toBe(1);
    expect(squireCardView(held, false, results.get(held.id)).result?.text).toBe("Undone.");
    expect(
      squireSection([held, question], results.all())?.toasts.map((toast) => toast.text),
    ).toEqual(["Rule saved."]);
    clock.advance(SQUIRE_RESULT_CLEAR_MS);
    expect(expired).toEqual([held.id]);
    clock.advance(SQUIRE_TOAST_CLEAR_MS - SQUIRE_RESULT_CLEAR_MS);
    expect(expired).toEqual([held.id, "offer"]);
    expect(results.all().map((result) => result.text)).toEqual(["Release is paused."]);
    expect(clock.count).toBe(0);
  });

  it("starts a toast's 10 s once an error's card leaves the list", () => {
    const clock = fakeTimeouts();
    const expired: string[] = [];
    const results = new SquireResults((rowId) => expired.push(rowId), clock.timers);
    results.sync(onCard);
    results.record({ rowId: held.id, kind: "error", text: "Release is paused.", title: "" });
    expect(clock.count).toBe(0);
    results.sync(new Set([question.id]));
    clock.advance(SQUIRE_TOAST_CLEAR_MS);
    expect(expired).toEqual([held.id]);
  });
});

describe("notch Squire section", () => {
  const { squire: _squire, ...rest } = held;
  const thread = { ...rest, id: "thread-row" };

  it("has a header whenever Squire cards exist, alone or among threads", () => {
    expect(squireSection([thread], [])).toBeNull();
    expect(squireSection([thread, question], [])?.cards).toEqual([question]);
    expect(squireSection([question], [])?.toasts).toEqual([]);
  });

  it("keeps a result whose card is gone as a toast, header included", () => {
    const sent = at({ rowId: held.id, kind: "success", text: "Sent.", title: held.title });
    expect(squireSection([thread, question], [sent])).toEqual({
      cards: [question],
      toasts: [sent],
    });
    expect(squireSection([thread], [sent])).toEqual({ cards: [], toasts: [sent] });
  });

  it("counts Squire cards and shows the empty state only with nothing in the list", () => {
    expect(activityListState([question], squireSection([question], []))).toEqual({
      count: 1,
      empty: false,
    });
    const toast = at({ rowId: held.id, kind: "info", text: "This item was dismissed.", title: "" });
    expect(activityListState([], squireSection([], [toast]))).toEqual({ count: 0, empty: false });
    expect(activityListState([], squireSection([], []))).toEqual({ count: 0, empty: true });
  });
});

describe("notch Squire result contrast", () => {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const rgba = (hex: string) => {
    const digits = hex.slice(1);
    const [r, g, b] = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
    return {
      rgb: [r!, g!, b!],
      alpha: digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1,
    };
  };
  const over = (top: string, under: ReadonlyArray<number>) => {
    const { rgb, alpha } = rgba(top);
    return rgb.map((value, index) => value * alpha + under[index]! * (1 - alpha));
  };
  const luminance = ([r, g, b]: ReadonlyArray<number>) =>
    0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
  const ratio = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high! + 0.05) / (low! + 0.05);
  };

  it("reads at 4.5:1 or better on the card in both themes, whatever the wallpaper shows", () => {
    expect(activityDocument).toContain(
      ".squire-result.success,.squire-toast.success{color:var(--activity-complete)}",
    );
    expect(activityDocument).toContain(
      ".squire-result.info,.squire-toast.info{color:var(--activity-text)}",
    );
    expect(activityDocument).toContain(
      ".squire-result.error,.squire-toast.error{color:var(--activity-failed)}",
    );
    const themes = activityThemeStyles.split("@media");
    expect(themes).toHaveLength(2);
    for (const theme of themes) {
      const variable = (name: string) =>
        theme.match(new RegExp(`--activity-${name}:(#[0-9a-fA-F]{6,8})`))![1]!;
      for (const wallpaperImage of [
        [0, 0, 0],
        [255, 255, 255],
      ]) {
        const surface = over(variable("card"), over(variable("wallpaper-top"), wallpaperImage));
        for (const text of ["complete", "failed", "muted", "text"])
          expect(ratio(rgba(variable(text)).rgb, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
