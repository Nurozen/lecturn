import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import type { SquireCardId, SquireCardRow, ThreadId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  squireComposerBannerState,
  squireHoldText,
  trackedThreadBanner,
} from "./squireThreadBanners.logic";

type BannerEntry = Parameters<typeof squireComposerBannerState>[0] & {};

const receivedAt = 1_000_000;
const formatTime = (iso: string) => `at ${iso.slice(11, 16)}`;

function entry(overrides: {
  readonly held?: SquireSnapshotEntry["held"];
  readonly budget?: SquireSnapshotEntry["budget"];
  readonly budgets?: { readonly steersPerDay: number; readonly threadsPerDay: number };
}): BannerEntry {
  return {
    receivedAt,
    held: overrides.held ?? [],
    budget: overrides.budget ?? { steersLeft: 3, threadsLeft: 2 },
    squire: { budgets: overrides.budgets ?? { steersPerDay: 10, threadsPerDay: 3 } },
  } as unknown as BannerEntry;
}

const hold = (cardId: string, executesInMs: number) => ({
  cardId: cardId as SquireCardId,
  kind: "steer" as const,
  targetThreadId: "thread-1" as ThreadId,
  executesInMs,
});

describe("composer banner state", () => {
  it("shows nothing with no hold and budget left, or before the Squire is listed", () => {
    expect(squireComposerBannerState(entry({}), receivedAt, formatTime)).toEqual({ kind: "none" });
    expect(squireComposerBannerState(null, receivedAt, formatTime)).toEqual({ kind: "none" });
  });

  it("counts a hold down from when the snapshot arrived, in whole seconds", () => {
    const held = entry({ held: [hold("card-1", 12_000)] });
    const at = (elapsedMs: number) => {
      const state = squireComposerBannerState(held, receivedAt + elapsedMs, formatTime);
      if (state.kind !== "banners") throw new Error("expected banners");
      const first = state.holds[0]!;
      return squireHoldText(first.kind, "Fix login", first.seconds);
    };
    expect(at(0)).toBe("Sending a steer to Fix login in 12s");
    expect(at(2_500)).toBe("Sending a steer to Fix login in 10s");
    expect(at(11_999)).toBe("Sending a steer to Fix login in 1s");
    expect(at(30_000)).toBe("Sending a steer to Fix login now");
  });

  it("names a spent budget, and a zero allowance is not spent", () => {
    const spent = squireComposerBannerState(
      entry({
        budget: { steersLeft: 0, threadsLeft: 0, recommendingUntil: "2026-11-02T09:00:00.000Z" },
        budgets: { steersPerDay: 10, threadsPerDay: 0 },
      }),
      receivedAt,
      formatTime,
    );
    expect(spent).toEqual({
      kind: "banners",
      holds: [],
      budget: {
        text: "Budget reached, recommending only until at 09:00",
        detail: "0 of 10 steers left today",
      },
    });
    expect(
      squireComposerBannerState(
        entry({
          budget: { steersLeft: 0, threadsLeft: 2 },
          budgets: { steersPerDay: 0, threadsPerDay: 3 },
        }),
        receivedAt,
        formatTime,
      ),
    ).toEqual({ kind: "none" });
  });
});

describe("tracked-thread banner", () => {
  const row = (id: string, overrides: Partial<SquireCardRow> = {}) =>
    ({
      id: id as SquireCardId,
      status: "open",
      targetThreadId: "thread-1" as ThreadId,
      createdAt: "2026-11-01T10:00:00.000Z",
      ...overrides,
    }) as const;

  it("counts open decisions on this thread and opens the oldest", () => {
    expect(
      trackedThreadBanner(
        [
          row("newer", { createdAt: "2026-11-01T11:00:00.000Z" }),
          row("older"),
          row("elsewhere", { targetThreadId: "thread-2" as ThreadId }),
          row("held", { status: "held" }),
        ],
        "thread-1",
        "Release",
      ),
    ).toEqual({ text: "Release · 2 need a decision" });
    expect(trackedThreadBanner([row("only")], "thread-1", "Release")?.text).toBe(
      "Release · 1 needs a decision",
    );
    expect(trackedThreadBanner([row("elsewhere")], "thread-2", "Release")).toBeNull();
  });
});
