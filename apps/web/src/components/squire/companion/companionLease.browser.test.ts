import "../../../index.css";

import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import { SquireId, SquireSnapshot } from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { createElement, useRef, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render as renderScreen, type Screen } from "../../../../test/render";

import { SquireCompanion } from "../SquireCompanion";
import { createManualCompanionClock, setCompanionClockForTests } from "./companionClock";
import { SquireHoverCard } from "./SquireHoverCard";
import {
  resetSquireGesturesForTests,
  useSquireGesturePlayer,
  type SquireGestureTarget,
} from "./squireGesturePlayer";
import type { CompanionGesture, SquireCompanion as SquireCompanionChoice } from "./types";
import type { SquireRigElement } from "./squireRig";

const at = "2026-11-01T10:00:00.000Z";
const companion: SquireCompanionChoice = {
  presence: "figure",
  appearance: "female",
  hood: "down",
  equipment: "lance",
  palette: "sage",
  frame: "orbit",
  weight: "regular",
  glow: "soft",
  motion: "subtle",
};
const idle = { state: "idle", badge: null, workingLabel: false } as const;

type Activity = SquireSnapshot["recentActivity"][number];
const activity = (sequence: number, gesture?: Activity["gesture"]): Activity => ({
  sequence,
  kind: "event.received",
  at,
  ...(gesture === undefined ? {} : { gesture }),
});

const decodeSnapshot = Schema.decodeUnknownSync(SquireSnapshot);
const entry = (id: string, recentActivity: ReadonlyArray<Activity> = []): SquireSnapshotEntry => ({
  ...decodeSnapshot({
    squire: {
      id,
      role: "squire",
      name: id,
      lifecycle: "ready",
      status: "active",
      homeProjectId: "project-a",
      homeThreadId: `thread-${id}`,
      providerInstanceId: null,
      modelSelection: null,
      summaryModelSelection: null,
      brief: "",
      grants: [],
      undoWindowSeconds: 10,
      digest: null,
      sweep: null,
      onboardedAt: null,
      automationPausedAt: null,
      revision: 0,
      createdAt: at,
      updatedAt: at,
      companion,
    },
    openDecisionCount: 0,
    countsByKind: { steer: 0, question: 0, overlap: 0, proposal: 0, fyi: 0 },
    held: [],
    budget: { steersLeft: 7, threadsLeft: 3 },
    conflicts: [],
    trackedCount: 2,
    containerNames: [],
    recentActivity,
    itemsRevision: 0,
    decisionRevision: 0,
  }),
  receivedAt: 0,
});

let clock: ReturnType<typeof createManualCompanionClock>;
// The current mount; render() mounts on first use and rerenders after, remount() starts over.
let screen: Screen | undefined;
let screens: Screen[] = [];

// A manual clock for one test; disposing unmounts every mount and resets the clock and gestures.
function setup(): AsyncDisposable {
  clock = createManualCompanionClock({ frameMs: 1000 / 60 });
  setCompanionClockForTests(clock);
  screen = undefined;
  screens = [];
  return {
    async [Symbol.asyncDispose]() {
      try {
        for (const mounted of screens) await mounted[Symbol.asyncDispose]();
      } finally {
        screen = undefined;
        screens = [];
        setCompanionClockForTests(null);
        resetSquireGesturesForTests();
      }
    },
  };
}

async function render(element: ReactElement) {
  if (screen) return screen.rerender(element);
  screen = await renderScreen(element, { router: false });
  screens.push(screen);
}
async function remount() {
  await screen?.unmount();
  screen = undefined;
}
const rigIn = (selector: string) =>
  document.querySelector<SquireRigElement>(`${selector} squire-rig`);
const hoverBusts = () => document.querySelectorAll('[data-testid="squire-hover-bust"] squire-rig');

function panel() {
  return createElement(
    "div",
    {
      "data-panel": "",
      style: { position: "fixed", left: "0px", top: "260px", width: "200px" },
    },
    createElement(SquireCompanion, {
      companion,
      state: "idle",
      label: "Panel",
      placement: "panel",
    }),
  );
}

function portrait(id: string, left: number) {
  return createElement(SquireHoverCard, {
    cardKey: id,
    entry: entry(id),
    indicator: idle,
    isLead: false,
    // oxlint-disable-next-line react/no-children-prop -- no JSX in a .ts file, and rest children do not satisfy a required prop
    children: createElement("span", {
      "data-portrait": id,
      style: { position: "fixed", top: "0px", left: `${left}px`, width: "22px", height: "22px" },
    }),
  });
}

async function framesWhile(rig: SquireRigElement, ms: number) {
  const before = rig.debugState.frameCount;
  clock.advance(ms);
  return rig.debugState.frameCount - before;
}

describe("single live rig across the panel and the sidebar hover card", () => {
  it("stills the panel while one hover card is open and hands the lease back on unmount", async () => {
    await using _env = setup();
    await render(createElement("div", null, panel(), portrait("a", 0), portrait("b", 60)));
    const panelRig = rigIn("[data-panel]")!;
    await vi.waitFor(() => expect(panelRig.debugState.reason).toBeNull(), { timeout: 10_000 });
    expect(await framesWhile(panelRig, 500)).toBeGreaterThan(0);

    await userEvent.hover(document.querySelector('[data-portrait="a"]')!);
    await vi.waitFor(() => expect(hoverBusts()).toHaveLength(1), { timeout: 5_000 });
    expect(panelRig.debugState.reason).toBe("yielded");
    expect(await framesWhile(panelRig, 500)).toBe(0);

    // Moving to another portrait swaps the card: never two busts, and the panel stays still.
    let mostBusts = 0;
    const watch = new MutationObserver(() => {
      mostBusts = Math.max(mostBusts, hoverBusts().length);
    });
    watch.observe(document.body, { childList: true, subtree: true });
    await userEvent.hover(document.querySelector('[data-portrait="b"]')!);
    await vi.waitFor(
      () => {
        const busts = hoverBusts();
        expect(busts).toHaveLength(1);
        expect(busts[0]!.getAttribute("label")).toMatch(/^b:/);
      },
      { timeout: 5_000 },
    );
    watch.disconnect();
    expect(mostBusts).toBe(1);
    expect(panelRig.debugState.reason).toBe("yielded");

    await userEvent.unhover(document.querySelector('[data-portrait="b"]')!);
    await vi.waitFor(() => expect(hoverBusts()).toHaveLength(0), { timeout: 5_000 });
    expect(panelRig.debugState.reason).toBeNull();
    expect(await framesWhile(panelRig, 500)).toBeGreaterThan(0);
  });
});

describe("gesture player", () => {
  const squireId = SquireId.make("release");

  function Player(props: {
    readonly recentActivity: ReadonlyArray<Activity>;
    readonly target: SquireGestureTarget;
  }) {
    const target = useRef(props.target);
    useSquireGesturePlayer(squireId, props.recentActivity, target);
    return null;
  }

  function recorder() {
    const played: CompanionGesture[] = [];
    let running = 0;
    const target: SquireGestureTarget = {
      async play(name) {
        // One at a time: a gesture starts only after the previous one finished.
        expect(running).toBe(0);
        running += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        played.push(name);
        running -= 1;
        return { name, played: true };
      },
    };
    return { played, target };
  }

  it("plays unseen activity once, in order, and never replays after a remount", async () => {
    await using _env = setup();
    const first = recorder();
    const history = [activity(1, "greet"), activity(2, "ponder")];
    await render(createElement(Player, { recentActivity: history, target: first.target }));
    // First open in the session greets once; the log it arrives with is history.
    await vi.waitFor(() => expect(first.played).toEqual(["greet"]));

    const live = [...history, activity(3, "listen"), activity(4), activity(5, "nod")];
    await render(createElement(Player, { recentActivity: live, target: first.target }));
    await vi.waitFor(() => expect(first.played).toEqual(["greet", "listen", "nod"]));

    // A reconnect re-sends the same log to a fresh mount: nothing at or below 5 plays again.
    await remount();
    const second = recorder();
    await render(createElement(Player, { recentActivity: live, target: second.target }));
    const reconnected = [...live.slice(1), activity(6, "flourish")];
    await render(createElement(Player, { recentActivity: reconnected, target: second.target }));
    await vi.waitFor(() => expect(second.played).toEqual(["flourish"]));
  });

  it("baselines an empty log on first open so the first new entry still plays", async () => {
    await using _env = setup();
    const { played, target } = recorder();
    await render(createElement(Player, { recentActivity: [], target }));
    await render(createElement(Player, { recentActivity: [activity(1, "glance")], target }));
    await vi.waitFor(() => expect(played).toEqual(["greet", "glance"]));
  });
});
