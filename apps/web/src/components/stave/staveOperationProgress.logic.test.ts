import {
  initialStaveOperationState,
  reduceStaveProgressEvent,
  type StaveOperationState,
} from "@lecturn/client-runtime/state/stave-operation";
import type { StaveOperationError, StaveProgressEvent } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeOperationError,
  formatPhaseDuration,
  NO_PARTIAL_SPACE_HINT,
  outputLineText,
  outputRuns,
  overallStatusLabel,
  phaseStatus,
  removePartialSpaceAvailability,
  truncatedNotice,
} from "./staveOperationProgress.logic";

const operationId = "op-1";

function event<T extends StaveProgressEvent>(value: T): T {
  return value;
}

const phaseStarted = (sequence: number, phase: string) =>
  event({ operationId, sequence, kind: "phase_started", phase });
const phaseFinished = (sequence: number, phase: string, durationMs = 100) =>
  event({ operationId, sequence, kind: "phase_finished", phase, durationMs });
const failed = (sequence: number, error: StaveOperationError) =>
  event({ operationId, sequence, kind: "failed", error });

function reduceAll(events: ReadonlyArray<StaveProgressEvent>): StaveOperationState {
  return events.reduce(
    (state, next) => reduceStaveProgressEvent(state, next, 1_000),
    initialStaveOperationState(operationId),
  );
}

const spaceExists: StaveOperationError = {
  code: "space_exists",
  message: "space 'demo' already exists",
  details: null,
  verb: "space create",
};

describe("phaseStatus", () => {
  it("marks finished phases done and the open phase running while the operation runs", () => {
    const state = reduceAll([
      phaseStarted(1, "pre-flight"),
      phaseFinished(2, "pre-flight"),
      phaseStarted(3, "space create"),
    ]);
    expect(state.phases.map((phase, index) => phaseStatus(phase, index, state))).toEqual([
      "done",
      "running",
    ]);
  });

  it("marks only the last phase failed when the operation failed after its phase_finished", () => {
    const state = reduceAll([
      phaseStarted(1, "pre-flight"),
      phaseFinished(2, "pre-flight"),
      phaseStarted(3, "space create"),
      phaseFinished(4, "space create"),
      failed(5, spaceExists),
    ]);
    expect(state.phases.map((phase, index) => phaseStatus(phase, index, state))).toEqual([
      "done",
      "failed",
    ]);
  });

  it("marks an open phase failed when the operation failed without closing it", () => {
    const state = reduceAll([phaseStarted(1, "pre-flight"), failed(2, spaceExists)]);
    expect(phaseStatus(state.phases[0]!, 0, state)).toBe("failed");
  });

  it("marks an open phase interrupted when disconnected and done when finished", () => {
    const running = reduceAll([phaseStarted(1, "verify")]);
    const disconnected: StaveOperationState = { ...running, status: "disconnected" };
    expect(phaseStatus(disconnected.phases[0]!, 0, disconnected)).toBe("interrupted");

    const finished: StaveOperationState = { ...running, status: "finished" };
    expect(phaseStatus(finished.phases[0]!, 0, finished)).toBe("done");
  });
});

describe("formatPhaseDuration", () => {
  it("uses tenths under ten seconds, whole seconds under a minute, then minutes", () => {
    expect(formatPhaseDuration(400)).toBe("0.4s");
    expect(formatPhaseDuration(9_960)).toBe("10.0s");
    expect(formatPhaseDuration(12_400)).toBe("12s");
    expect(formatPhaseDuration(65_000)).toBe("1m 05s");
    expect(formatPhaseDuration(754_000)).toBe("12m 34s");
  });

  it("clamps negative durations to zero", () => {
    expect(formatPhaseDuration(-5)).toBe("0.0s");
  });
});

describe("describeOperationError", () => {
  it("joins the code with the verb when the server knew it", () => {
    expect(describeOperationError(spaceExists)).toEqual({
      title: "space_exists (space create)",
      detail: "space 'demo' already exists",
    });
  });

  it("uses the bare code for pre-flight refusals", () => {
    expect(
      describeOperationError({ code: "invalid_arguments", message: "bad id", details: null }),
    ).toEqual({ title: "invalid_arguments", detail: "bad id" });
  });
});

describe("removePartialSpaceAvailability", () => {
  it("is unavailable when no partial space was reported", () => {
    const state = reduceAll([phaseStarted(1, "pre-flight"), failed(2, spaceExists)]);
    expect(removePartialSpaceAvailability(state, "demo")).toEqual({
      kind: "unavailable",
      hint: NO_PARTIAL_SPACE_HINT,
    });
  });

  it("is unavailable with a manual hint when the manifest stamp is unknown", () => {
    const state = reduceAll([
      phaseStarted(1, "verify"),
      failed(2, {
        code: "unreadable",
        message: "manifest unreadable",
        details: { partialSpace: { spaceId: "demo", spacePath: "/work/demo" } },
        verb: "space create",
      }),
    ]);
    const availability = removePartialSpaceAvailability(state, "demo");
    expect(availability.kind).toBe("unavailable");
    if (availability.kind === "unavailable") {
      expect(availability.hint).toContain("/work/demo");
      expect(availability.hint).toContain("stave space destroy demo");
    }
  });

  it("builds the stamp-bound destroy when the partial space carries its manifest stamp", () => {
    const state = reduceAll([
      phaseStarted(1, "verify"),
      failed(2, {
        code: "unreadable",
        message: "manifest unreadable",
        details: {
          partialSpace: {
            spaceId: "demo",
            spacePath: "/work/demo",
            manifestCreatedAt: "2026-09-07T10:00:00.000Z",
          },
        },
        verb: "space create",
      }),
    ]);
    expect(removePartialSpaceAvailability(state, "fallback")).toEqual({
      kind: "available",
      operation: {
        kind: "removePartialSpace",
        spaceId: "demo",
        expectedManifestCreatedAt: "2026-09-07T10:00:00.000Z",
      },
    });
  });

  it("falls back to the wizard's space id when the report omits one", () => {
    const state = reduceAll([
      failed(1, {
        code: "unreadable",
        message: "manifest unreadable",
        details: { spacePath: "/work/demo", manifestCreatedAt: "2026-09-07T10:00:00.000Z" },
      }),
    ]);
    const availability = removePartialSpaceAvailability(state, "demo");
    expect(availability.kind === "available" && availability.operation.spaceId).toBe("demo");
  });
});

describe("overallStatusLabel", () => {
  it("labels every status", () => {
    const idle = initialStaveOperationState(operationId);
    expect(overallStatusLabel(idle)).toBe("Not started");
    expect(overallStatusLabel(reduceAll([phaseStarted(1, "pre-flight")]))).toBe("Running…");
    expect(overallStatusLabel({ ...idle, status: "finished" })).toBe("Finished");
    expect(overallStatusLabel(reduceAll([failed(1, spaceExists)]))).toBe("Failed");
    expect(overallStatusLabel({ ...idle, status: "disconnected" })).toBe("Disconnected");
  });
});

describe("output and truncation text", () => {
  it("prefixes notes and leaves the other streams alone", () => {
    expect(outputLineText({ stream: "notes", text: "created worktree" })).toBe(
      "note: created worktree",
    );
    expect(outputLineText({ stream: "stdout", text: "raw" })).toBe("raw");
    expect(outputLineText({ stream: "stderr", text: "warn" })).toBe("warn");
    expect(outputLineText({ stream: "plan", text: "step" })).toBe("step");
  });

  it("collapses consecutive lines of one stream into runs keyed by their first line", () => {
    expect(
      outputRuns([
        { stream: "stdout", text: "a" },
        { stream: "stdout", text: "b" },
        { stream: "notes", text: "c" },
        { stream: "stdout", text: "d" },
      ]),
    ).toEqual([
      { stream: "stdout", startLine: 1, text: "a\nb" },
      { stream: "notes", startLine: 3, text: "note: c" },
      { stream: "stdout", startLine: 4, text: "d" },
    ]);
    expect(outputRuns([])).toEqual([]);
  });

  it("reports the replay cursor after a reset and nothing otherwise", () => {
    expect(truncatedNotice(reduceAll([phaseStarted(1, "pre-flight")]))).toBeNull();
    const reset = reduceAll([
      phaseStarted(1, "pre-flight"),
      event({ operationId, sequence: 0, kind: "reset", earliestSequence: 7 }),
    ]);
    expect(truncatedNotice(reset)).toBe("Earlier output was evicted; showing from sequence 7.");
  });
});
