import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/swift-ui", () => ({
  HStack: "HStack",
  Image: "Image",
  Link: "Link",
  Rectangle: "Rectangle",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
  ZStack: "ZStack",
}));

vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  activityBackgroundTint: (value: unknown) => ({ activityBackgroundTint: value }),
  background: (value: unknown) => ({ background: value }),
  clipShape: (value: unknown) => value,
  strokeBorder: (value: unknown) => value,
  font: (value: unknown) => value,
  foregroundStyle: (value: unknown) => value,
  frame: (value: unknown) => value,
  layoutPriority: (value: unknown) => value,
  lineLimit: (value: unknown) => value,
  padding: (value: unknown) => value,
  opacity: (value: unknown) => value,
  resizable: (value: unknown) => value,
  widgetURL: (value: unknown) => ({ widgetURL: value }),
}));

vi.mock("expo-widgets", () => ({
  createLiveActivity: vi.fn((name: string, layout: unknown) => ({ layout, name })),
}));

import {
  AgentActivity,
  type AgentActivityProps,
  type AgentActivityRowProps,
} from "./AgentActivity";

function makeRow(overrides: Partial<AgentActivityRowProps>): AgentActivityRowProps {
  return {
    environmentId: "env-1",
    threadId: "thread-1",
    projectTitle: "Project",
    threadTitle: "Thread",
    modelTitle: "gpt-5.4",
    phase: "running",
    status: "Working",
    updatedAt: "2026-05-25T13:07:00.000Z",
    deepLink: "/threads/env-1/thread-1",
    ...overrides,
  };
}

const props = {
  title: "Lecturn",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: "2026-05-25T13:07:00.000Z",
  activities: [],
} satisfies AgentActivityProps;

const environment = {
  colorScheme: "dark",
  isLuminanceReduced: false,
} as const;

const lightEnvironment = {
  colorScheme: "light",
  isLuminanceReduced: false,
} as const;

describe("AgentActivity widget layout", () => {
  it("tints legacy opaque backgrounds without recoloring the brand", () => {
    const teal = AgentActivity(
      { ...props, iosMajorVersion: 18, accountColor: "#14b8a6" },
      environment as never,
    );
    const violet = AgentActivity(
      { ...props, iosMajorVersion: 18, accountColor: "#8b5cf6" },
      environment as never,
    );
    expect(JSON.stringify(teal.banner)).toContain('"activityBackgroundTint":"#0a3e43"');
    expect(JSON.stringify(violet.banner)).toContain('"activityBackgroundTint":"#272757"');
    expect(teal.compactLeading).toEqual(violet.compactLeading);
    expect(JSON.stringify(teal.expandedLeading)).toContain('"background":"#0a3e43"');
    expect(JSON.stringify(violet.expandedBottom)).toContain('"background":"#272757"');
  });
  it("uses account color only for the system glass background, preserving brand foregrounds", () => {
    const unowned = AgentActivity({ ...props, iosMajorVersion: 26 }, environment as never);
    const owned = AgentActivity(
      { ...props, iosMajorVersion: 26, accountColor: "#14b8a6" },
      environment as never,
    );
    // Only the host background changes: logo, title, rows, and compact islands
    // must keep exactly the same brand/semantic colors.
    expect(JSON.stringify(owned.banner).replaceAll("#14b8a640", "#00000000")).toBe(
      JSON.stringify(unowned.banner),
    );
    expect(owned.compactLeading).toEqual(unowned.compactLeading);
    expect(owned.compactTrailing).toEqual(unowned.compactTrailing);
    expect(owned.minimal).toEqual(unowned.minimal);
    for (const surface of [owned.expandedLeading, owned.expandedBottom]) {
      expect(JSON.stringify(surface)).toContain('"background":"#14b8a640"');
      expect(JSON.stringify(surface).replaceAll('"background":"#14b8a640"', "")).not.toContain(
        "#14b8a6",
      );
    }
  });

  it.each([undefined, "red", "#abc", "#12345678", "invalid"])(
    "uses the system background when account color %s is not a six-digit hex color",
    (accountColor) => {
      const layout = AgentActivity(
        { ...props, iosMajorVersion: 26, accountColor },
        environment as never,
      );
      expect(JSON.stringify(layout.banner)).toContain('"activityBackgroundTint":"#00000000"');
    },
  );

  it.each(["light", "dark"] as const)(
    "preserves activity text in the iOS 26 glass layout in %s appearance",
    (colorScheme) => {
      for (const isLuminanceReduced of [false, true]) {
        const layout = AgentActivity(
          {
            ...props,
            iosMajorVersion: 26,
            accountLabel: "Work",
            accountColor: "#14b8a6",
            activities: [makeRow({ threadTitle: "Review changes" })],
          },
          { colorScheme, isLuminanceReduced } as never,
        );
        expect(JSON.stringify(layout.banner)).toContain("Review changes");
        expect(JSON.stringify(layout.bannerSmall)).toContain("Review changes");
        expect(JSON.stringify(layout.expandedBottom)).toContain("Review changes");
        for (const surface of [layout.banner, layout.bannerSmall, layout.expandedBottom]) {
          const serialized = JSON.stringify(surface);
          expect(serialized).not.toContain('"glassEffect"');
        }
        expect(JSON.stringify(layout.banner)).toContain('"activityBackgroundTint":"#14b8a640"');
        expect(JSON.stringify(layout.bannerSmall)).toContain(
          '"activityBackgroundTint":"#14b8a640"',
        );
      }
    },
  );

  it("tints each row by its own phase on the branded dark surface", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_approval", status: "Approval" }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("#e6bc63"); // Lecturn gold: running
    expect(banner).toContain("#f0b34d"); // shared attention amber: waiting_for_approval
  });

  it("keeps readable status colors on its navy surface in a light host", () => {
    // The banner owns its navy background even when the mirrored Mac host is light.
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_approval", status: "Approval" }),
        ],
      },
      lightEnvironment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("#f0b34d"); // shared attention amber remains legible on navy
    expect(banner).not.toContain("#9a6700");
    expect(banner).toContain("#061522");
  });

  it("orders rows attention-first in the banner", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({ threadTitle: "Working thread" }),
          makeRow({
            threadId: "thread-2",
            threadTitle: "Blocked thread",
            phase: "waiting_for_approval",
            status: "Approval",
          }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner.indexOf("Blocked thread")).toBeGreaterThan(-1);
    expect(banner.indexOf("Blocked thread")).toBeLessThan(banner.indexOf("Working thread"));
  });

  it("summarizes the attention count in the banner header", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 3,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_input", status: "Input" }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("3 active agents");
    expect(banner).toContain("1 needs attention");
  });

  it("keeps the compact brand mark and attention status distinct", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_input", status: "Input" }),
        ],
      },
      environment as never,
    );
    expect(JSON.stringify(layout.compactLeading)).toContain("#e6bc63"); // brand mark
    expect(JSON.stringify(layout.compactTrailing)).toContain("Input");
    expect(JSON.stringify(layout.minimal)).toContain("#f0b34d");
  });

  it("deep links the banner to the row that needs attention", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({
            threadId: "thread-2",
            phase: "waiting_for_approval",
            status: "Approval",
            deepLink: "/threads/env-1/thread-2",
          }),
        ],
      },
      environment as never,
    );
    expect(JSON.stringify(layout.banner)).toContain(
      '"widgetURL":"lecturn://threads/env-1/thread-2"',
    );
  });

  it("deep links the banner to the first row when nothing needs attention", () => {
    const layout = AgentActivity({ ...props, activities: [makeRow({})] }, environment as never);
    expect(JSON.stringify(layout.banner)).toContain(
      '"widgetURL":"lecturn://threads/env-1/thread-1"',
    );
  });

  it("omits the deep link for unsafe paths and empty aggregates", () => {
    expect(JSON.stringify(AgentActivity(props, environment as never))).not.toContain("widgetURL");
    expect(
      JSON.stringify(
        AgentActivity(
          { ...props, activities: [makeRow({ deepLink: "//evil.example" })] },
          environment as never,
        ),
      ),
    ).not.toContain("widgetURL");
  });

  it("leads with the outcome instead of a zero count when nothing is active", () => {
    const layout = AgentActivity(
      {
        ...props,
        subtitle: "Agent work completed",
        activeCount: 0,
        activities: [makeRow({ phase: "completed", status: "Done" })],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Agent work completed");
    expect(banner).not.toContain("0 active");
    expect(banner).toContain("#56c5a1"); // shared completed green header tint
    expect(JSON.stringify(layout.compactTrailing)).toContain("Done");
    expect(JSON.stringify(layout.compactTrailing)).not.toContain("0 active");
    expect(JSON.stringify(layout.expandedLeading)).toContain("Done");
    expect(JSON.stringify(layout.minimal)).toContain("checkmark.circle.fill");
    expect(JSON.stringify(layout.bannerSmall)).toContain("Done");
  });

  it("reads Failed when the finished work ended in failure", () => {
    const layout = AgentActivity(
      {
        ...props,
        subtitle: "Agent work failed",
        activeCount: 0,
        activities: [makeRow({ phase: "failed", status: "Failed" })],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Agent work failed");
    expect(banner).toContain("#f07868"); // shared failed red header tint
    expect(JSON.stringify(layout.compactTrailing)).toContain("Failed");
    expect(JSON.stringify(layout.expandedLeading)).toContain("Failed");
    expect(JSON.stringify(layout.minimal)).toContain("xmark.octagon.fill");
  });

  it("lets a failure dominate mixed finished outcomes across every presentation", () => {
    const layout = AgentActivity(
      {
        ...props,
        // The server subtitle keys off the newest terminal row (completed
        // here); the layout must still read Failed everywhere so the header
        // text never disagrees with the tint, count slots, or minimal glyph.
        subtitle: "Agent work completed",
        activeCount: 0,
        activities: [
          makeRow({ phase: "completed", status: "Done" }),
          makeRow({ threadId: "thread-2", phase: "failed", status: "Failed" }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Agent work failed");
    expect(banner).not.toContain("Agent work completed");
    expect(banner).toContain("#f07868"); // shared failed red header tint
    expect(JSON.stringify(layout.compactTrailing)).toContain("Failed");
    expect(JSON.stringify(layout.expandedLeading)).toContain("Failed");
    expect(JSON.stringify(layout.minimal)).toContain("xmark.octagon.fill");
  });

  it("renders up to five rows in the banner", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 6,
        activities: [1, 2, 3, 4, 5, 6].map((n) =>
          makeRow({ threadId: `t${n}`, threadTitle: `Thread ${n}` }),
        ),
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    for (const visible of [1, 2, 3, 4, 5]) {
      expect(banner).toContain(`Thread ${visible}`);
    }
    expect(banner).not.toContain("Thread 6");
  });
});

describe("pull request activity", () => {
  const pr = {
    watchId: "watch-1",
    projectId: "project-1",
    number: 42,
    repository: "owner/repo",
    state: "open",
    checks: "pending",
    requiredChecks: "unknown",
    watching: true,
    manager: "offline",
    authorization: "waiting",
    stale: true,
  } as const;
  it("keeps observation freshness, CI, watch intent and manager liveness distinct", () => {
    const layout = AgentActivity(
      {
        ...props,
        activities: [makeRow({ pullRequest: pr, deepLink: "/pr-watches/env-1/watch-1" })],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("CI pending");
    expect(banner).toContain("Required unknown");
    expect(banner).toContain("Stale · Watching · offline · Merge waiting");
    expect(banner).toContain("1 active activity");
    expect(banner).not.toContain("active agent");
    expect(banner).toContain('"destination":"lecturn://pr-watches/env-1/watch-1"');
  });
  it("caps the expanded PR layout at two rows and never links mutation parameters", () => {
    const layout = AgentActivity(
      {
        ...props,
        activities: [1, 2, 3, 4].map((number) =>
          makeRow({
            pullRequest: { ...pr, number, repository: `unique-${number}` },
            deepLink: "/pr-watches/env-1/watch-1?action=authorize",
          }),
        ),
      },
      environment as never,
    );
    expect(JSON.stringify(layout.expandedBottom)).toContain("unique-2");
    expect(JSON.stringify(layout.expandedBottom)).not.toContain("unique-3");
    expect(JSON.stringify(layout.banner)).not.toContain("unique-4");
    expect(JSON.stringify(layout.expandedBottom)).not.toContain('"destination"');
  });
});
