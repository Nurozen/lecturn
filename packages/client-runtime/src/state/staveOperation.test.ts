import {
  EnvironmentId,
  StaveOperationRejectedError,
  StaveUnavailableError,
  EnvironmentAuthorizationError,
  type StaveObserveOperationInput,
  type StaveOperation,
  type StaveOperationResult,
  type StaveProgressEvent,
  type StaveRunOperationInput,
} from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createStaveOperationManager,
  initialStaveOperationState,
  reduceStaveProgressEvent,
  runStaveOperation,
  type StaveOperationClient,
  type StaveOperationState,
} from "./staveOperation.ts";

const operationId = "op-1";
const environmentId = EnvironmentId.make("environment-1");
const operation: StaveOperation = { kind: "setup", force: false };
const finishedResult: StaveOperationResult = {
  kind: "setup",
  result: {
    configPath: "/home/me/.stave/config.yaml",
    root: "/home/me/stave",
    bareReposDir: "/home/me/stave/repos",
    agentWorkDir: "/home/me/stave/agent-work",
    created: ["/home/me/stave"],
    existed: [],
  },
};

function event<T extends StaveProgressEvent>(value: T): T {
  return value;
}

const phaseStarted = (sequence: number, phase: string, commandLine?: string) =>
  event({
    operationId,
    sequence,
    kind: "phase_started",
    phase,
    ...(commandLine === undefined ? {} : { commandLine }),
  });
const output = (sequence: number, phase: string, text: string) =>
  event({ operationId, sequence, kind: "output", phase, stream: "notes", text });
const phaseFinished = (sequence: number, phase: string, durationMs: number) =>
  event({ operationId, sequence, kind: "phase_finished", phase, durationMs });
const finished = (sequence: number) =>
  event({ operationId, sequence, kind: "finished", result: finishedResult });

function reduceAll(events: ReadonlyArray<StaveProgressEvent>, now = 1_000): StaveOperationState {
  return events.reduce(
    (state, next) => reduceStaveProgressEvent(state, next, now),
    initialStaveOperationState(operationId),
  );
}

describe("reduceStaveProgressEvent", () => {
  it("retains output per phase in arrival order", () => {
    const state = reduceAll([
      phaseStarted(0, "pre-flight"),
      phaseFinished(1, "pre-flight", 5),
      phaseStarted(2, "create space", "stave space create demo --json"),
      output(3, "create space", "created /work/demo"),
      output(4, "create space", "attached memory"),
      phaseFinished(5, "create space", 120),
    ]);

    expect(state.status).toBe("running");
    expect(state.lastSequence).toBe(5);
    expect(state.truncated).toBe(false);
    expect(state.phases).toEqual([
      { phase: "pre-flight", startedAt: 1_000, finishedAt: 1_000, durationMs: 5, lines: [] },
      {
        phase: "create space",
        commandLine: "stave space create demo --json",
        startedAt: 1_000,
        finishedAt: 1_000,
        durationMs: 120,
        lines: [
          { stream: "notes", text: "created /work/demo" },
          { stream: "notes", text: "attached memory" },
        ],
      },
    ]);
  });

  it("ignores replayed, out-of-order and foreign events", () => {
    const base = reduceAll([phaseStarted(0, "verify"), output(1, "verify", "ok")]);

    expect(reduceStaveProgressEvent(base, output(1, "verify", "again"), 2_000)).toBe(base);
    expect(reduceStaveProgressEvent(base, output(0, "verify", "earlier"), 2_000)).toBe(base);
    expect(
      reduceStaveProgressEvent(base, { ...output(2, "verify", "other"), operationId: "op-2" }, 0),
    ).toBe(base);
  });

  it("opens a phase lazily when output arrives before its start was seen", () => {
    const state = reduceAll([output(7, "attach memory", "late line")]);

    expect(state.phases).toEqual([
      { phase: "attach memory", startedAt: 1_000, lines: [{ stream: "notes", text: "late line" }] },
    ]);
    expect(state.lastSequence).toBe(7);
  });

  it("drops retained output on reset and accepts the replay from earliestSequence", () => {
    const before = reduceAll([phaseStarted(0, "pre-flight"), output(1, "pre-flight", "old")]);
    const reset = reduceStaveProgressEvent(
      before,
      event({ operationId, sequence: 9, kind: "reset", earliestSequence: 6 }),
      1_000,
    );

    expect(reset).toMatchObject({
      status: "running",
      phases: [],
      lastSequence: 5,
      earliestSequence: 6,
      truncated: true,
    });

    const replayed = reduceStaveProgressEvent(reset, output(6, "create space", "replayed"), 1_000);
    expect(replayed.lastSequence).toBe(6);
    expect(replayed.phases.map((phase) => phase.lines)).toEqual([
      [{ stream: "notes", text: "replayed" }],
    ]);
    expect(replayed.truncated).toBe(true);
  });

  it("settles on the terminal events and ignores anything after them", () => {
    const done = reduceAll([phaseStarted(0, "verify"), finished(1)]);
    expect(done.status).toBe("finished");
    expect(done.result).toEqual(finishedResult);
    expect(reduceStaveProgressEvent(done, phaseStarted(2, "late"), 0)).toBe(done);

    const failed = reduceAll([
      event({
        operationId,
        sequence: 0,
        kind: "failed",
        error: {
          code: "space_exists",
          message: "already there",
          details: null,
          verb: "space create",
        },
      }),
    ]);
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("space_exists");
  });
});

interface FakeClientCalls {
  readonly run: StaveRunOperationInput[];
  readonly observe: StaveObserveOperationInput[];
}

function fakeClient(
  streams: {
    readonly run: Stream.Stream<StaveProgressEvent, unknown>;
    readonly observe?: Stream.Stream<StaveProgressEvent, unknown>;
  },
  calls: FakeClientCalls,
): StaveOperationClient<unknown, never> {
  return {
    runOperation: (_environmentId, input) => {
      calls.run.push(input);
      return streams.run;
    },
    observeOperation: (_environmentId, input) => {
      calls.observe.push(input);
      return streams.observe ?? Stream.empty;
    },
  };
}

describe("runStaveOperation", () => {
  it.effect("follows the stream to its terminal event and reports every state", () =>
    Effect.gen(function* () {
      const calls: FakeClientCalls = { run: [], observe: [] };
      const seen: StaveOperationState["status"][] = [];
      const outcome = yield* runStaveOperation({
        client: fakeClient(
          { run: Stream.fromIterable([phaseStarted(0, "verify"), finished(1)]) },
          calls,
        ),
        environmentId,
        operationId,
        operation,
        onState: (state) => seen.push(state.status),
      });

      expect(calls.run).toEqual([{ operationId, operation }]);
      expect(outcome.state.status).toBe("finished");
      expect(outcome.state.result).toEqual(finishedResult);
      expect(seen).toEqual(["running", "running", "finished"]);

      const again = yield* outcome.reattach();
      expect(again.state).toBe(outcome.state);
      expect(calls.observe).toEqual([]);
    }),
  );

  it.effect(
    "marks a stream that closes without a terminal event as disconnected and reattaches",
    () =>
      Effect.gen(function* () {
        const calls: FakeClientCalls = { run: [], observe: [] };
        const outcome = yield* runStaveOperation({
          client: fakeClient(
            {
              run: Stream.fromIterable([
                phaseStarted(0, "create space"),
                output(1, "create space", "cloning"),
              ]),
              observe: Stream.fromIterable([
                output(1, "create space", "duplicate from overlap"),
                phaseFinished(2, "create space", 40),
                finished(3),
              ]),
            },
            calls,
          ),
          environmentId,
          operationId,
          operation,
        });

        expect(outcome.state.status).toBe("disconnected");
        expect(outcome.state.disconnectReason).toBeUndefined();
        expect(outcome.state.lastSequence).toBe(1);

        const resumed = yield* outcome.reattach();
        expect(calls.observe).toEqual([{ operationId, afterSequence: 1 }]);
        expect(resumed.state.status).toBe("finished");
        expect(resumed.state.phases).toEqual([
          {
            phase: "create space",
            startedAt: 0,
            finishedAt: 0,
            durationMs: 40,
            lines: [{ stream: "notes", text: "cloning" }],
          },
        ]);
      }),
  );

  it.effect("treats a transport failure mid-stream as a disconnect with a reason", () =>
    Effect.gen(function* () {
      const calls: FakeClientCalls = { run: [], observe: [] };
      const outcome = yield* runStaveOperation({
        client: fakeClient(
          {
            run: Stream.concat(
              Stream.fromIterable([phaseStarted(0, "pre-flight")]),
              Stream.fail(new Error("socket closed")),
            ),
          },
          calls,
        ),
        environmentId,
        operationId,
        operation,
        afterSequence: 4,
      });

      expect(calls.run).toEqual([{ operationId, operation, afterSequence: 4 }]);
      expect(outcome.state.status).toBe("disconnected");
      expect(outcome.state.disconnectReason).toBe("socket closed");
      expect(outcome.state.phases.map((phase) => phase.phase)).toEqual(["pre-flight"]);
    }),
  );

  it.effect(
    "settles unavailable and unauthorized starts without retrying an operation that never began",
    () =>
      Effect.gen(function* () {
        for (const failure of [
          new StaveUnavailableError({
            reason: "disabled_in_settings",
            message: "Stave was disabled",
          }),
          new EnvironmentAuthorizationError({
            requiredScope: "orchestration:operate",
            message: "Access denied",
          }),
        ]) {
          const calls: FakeClientCalls = { run: [], observe: [] };
          const outcome = yield* runStaveOperation({
            client: fakeClient({ run: Stream.fail(failure) }, calls),
            environmentId,
            operationId,
            operation,
          });
          expect(outcome.state.status).toBe("failed");
          expect(outcome.state.error?.message).toBe(failure.message);
          yield* outcome.reattach();
          expect(calls.observe).toEqual([]);
        }
      }),
  );

  it.effect("keeps an admitted operation resumable when access to its stream is refused", () =>
    Effect.gen(function* () {
      const calls: FakeClientCalls = { run: [], observe: [] };
      const outcome = yield* runStaveOperation({
        client: fakeClient(
          {
            run: Stream.fromIterable([phaseStarted(0, "create space")]),
            observe: Stream.fail(
              new StaveUnavailableError({
                reason: "disabled_in_settings",
                message: "Stave was disabled",
              }),
            ),
          },
          calls,
        ),
        environmentId,
        operationId,
        operation,
      });
      const resumed = yield* outcome.reattach();
      expect(resumed.state.status).toBe("disconnected");
      expect(resumed.state.lastSequence).toBe(0);
    }),
  );

  it.effect("turns a rejected start into a failed state instead of a disconnect", () =>
    Effect.gen(function* () {
      const calls: FakeClientCalls = { run: [], observe: [] };
      const outcome = yield* runStaveOperation({
        client: fakeClient(
          {
            run: Stream.fail(
              new StaveOperationRejectedError({
                operationId,
                code: "invalid_arguments",
                message: "already running with a different payload",
              }),
            ),
          },
          calls,
        ),
        environmentId,
        operationId,
        operation,
      });

      expect(outcome.state.status).toBe("failed");
      expect(outcome.state.error).toEqual({
        code: "invalid_arguments",
        message: "already running with a different payload",
        details: null,
      });
      const again = yield* outcome.reattach();
      expect(again.state).toBe(outcome.state);
      expect(calls.observe).toEqual([]);
    }),
  );
});

describe("createStaveOperationManager", () => {
  it("keys state by operation id", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const manager = createStaveOperationManager(runtime);
    const registry = AtomRegistry.make();

    expect(manager.stateAtom(operationId)).toBe(manager.stateAtom(operationId));
    expect(manager.stateAtom(operationId)).not.toBe(manager.stateAtom("op-2"));
    expect(registry.get(manager.stateAtom(operationId))).toEqual(
      initialStaveOperationState(operationId),
    );

    registry.dispose();
  });
});
