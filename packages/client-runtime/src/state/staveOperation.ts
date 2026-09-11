/**
 * Client side of a streamed Stave operation (`stave.runOperation` /
 * `stave.observeOperation`).
 *
 * Events are keyed on the client-supplied `operationId` and numbered by a
 * per-operation `sequence`, so the consumer is a pure reducer over
 * `StaveProgressEvent`s that keeps every phase's output for the progress view,
 * plus a runner that knows when the stream ended without a terminal event and
 * can reattach from the last sequence it saw (deviation 26). The reducer is
 * the reconnect boundary: a `reset` drops what the client holds and accepts
 * the server's replay from `earliestSequence`.
 */

import {
  type EnvironmentId,
  type StaveObserveOperationInput,
  type StaveOperation,
  type StaveOperationError,
  type StaveOperationResult,
  type StaveProgressEvent,
  type StaveProgressOutputStream,
  type StaveRunOperationInput,
  StaveOperationRejectedError,
  StaveUnavailableError,
  StaveNotSpaceError,
  ServerSettingsError,
  EnvironmentAuthorizationError,
  WS_METHODS,
} from "@lecturn/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { runStream } from "../rpc/client.ts";
import { createRuntimeCommand, runStreamInEnvironment } from "./runtime.ts";

export type StaveOperationStatus = "idle" | "running" | "finished" | "failed" | "disconnected";

export interface StaveOperationOutputLine {
  readonly stream: StaveProgressOutputStream;
  readonly text: string;
}

export interface StaveOperationPhaseState {
  readonly phase: string;
  /** The `stave ...` command line this phase runs, when the server reported one. */
  readonly commandLine?: string;
  /** Client clock (epoch ms) when the phase start was received. */
  readonly startedAt: number;
  readonly finishedAt?: number;
  /** Server-measured duration from `phase_finished`. */
  readonly durationMs?: number;
  readonly lines: ReadonlyArray<StaveOperationOutputLine>;
}

export interface StaveOperationState {
  readonly operationId: string;
  readonly status: StaveOperationStatus;
  /** Every phase seen, in arrival order, with its retained output. */
  readonly phases: ReadonlyArray<StaveOperationPhaseState>;
  /** Highest sequence applied; `null` before the first event. Reattach resumes after it. */
  readonly lastSequence: number | null;
  /** Set by a `reset`: the server had evicted everything before this sequence. */
  readonly earliestSequence?: number;
  /** A `reset` dropped retained output; the phases shown may not be the full history. */
  readonly truncated: boolean;
  readonly result?: StaveOperationResult;
  readonly error?: StaveOperationError;
  /** Why the stream ended while `disconnected`, when the transport failed rather than closed. */
  readonly disconnectReason?: string;
}

export function initialStaveOperationState(operationId: string): StaveOperationState {
  return {
    operationId,
    status: "idle",
    phases: [],
    lastSequence: null,
    truncated: false,
  };
}

export function isStaveOperationTerminal(status: StaveOperationStatus): boolean {
  return status === "finished" || status === "failed";
}

function findLastPhaseIndex(
  phases: ReadonlyArray<StaveOperationPhaseState>,
  phase: string,
  predicate: (candidate: StaveOperationPhaseState) => boolean = () => true,
): number {
  for (let index = phases.length - 1; index >= 0; index -= 1) {
    const candidate = phases[index];
    if (candidate !== undefined && candidate.phase === phase && predicate(candidate)) {
      return index;
    }
  }
  return -1;
}

function replacePhase(
  phases: ReadonlyArray<StaveOperationPhaseState>,
  index: number,
  next: StaveOperationPhaseState,
): ReadonlyArray<StaveOperationPhaseState> {
  return phases.map((candidate, candidateIndex) => (candidateIndex === index ? next : candidate));
}

/**
 * Applies one progress event. Events for another operation, events at or
 * below `lastSequence` (replays, reordering) and anything after a terminal
 * event are ignored, so the reducer is safe to feed from an attach stream
 * that overlaps what the client already holds.
 */
export function reduceStaveProgressEvent(
  state: StaveOperationState,
  event: StaveProgressEvent,
  receivedAtMs: number,
): StaveOperationState {
  if (event.operationId !== state.operationId) {
    return state;
  }
  if (isStaveOperationTerminal(state.status)) {
    return state;
  }
  if (event.kind === "reset") {
    // The requested cursor was evicted: whatever is retained predates the
    // replay, so drop it and accept everything from `earliestSequence` on.
    return {
      operationId: state.operationId,
      status: "running",
      phases: [],
      lastSequence: event.earliestSequence > 0 ? event.earliestSequence - 1 : null,
      earliestSequence: event.earliestSequence,
      truncated: true,
    };
  }
  if (state.lastSequence !== null && event.sequence <= state.lastSequence) {
    return state;
  }

  const base: StaveOperationState = {
    ...state,
    status: "running",
    lastSequence: event.sequence,
  };
  const { disconnectReason: _disconnectReason, ...running } = base;

  switch (event.kind) {
    case "phase_started":
      return {
        ...running,
        phases: [
          ...state.phases,
          {
            phase: event.phase,
            ...(event.commandLine === undefined ? {} : { commandLine: event.commandLine }),
            startedAt: receivedAtMs,
            lines: [],
          },
        ],
      };
    case "output": {
      const line: StaveOperationOutputLine = { stream: event.stream, text: event.text };
      const index = findLastPhaseIndex(state.phases, event.phase);
      if (index === -1) {
        // Output for a phase whose start was evicted or never seen (attach
        // mid-phase): open it now so the lines still have a home.
        return {
          ...running,
          phases: [...state.phases, { phase: event.phase, startedAt: receivedAtMs, lines: [line] }],
        };
      }
      const current = state.phases[index]!;
      return {
        ...running,
        phases: replacePhase(state.phases, index, {
          ...current,
          lines: [...current.lines, line],
        }),
      };
    }
    case "phase_finished": {
      const index = findLastPhaseIndex(
        state.phases,
        event.phase,
        (candidate) => candidate.finishedAt === undefined,
      );
      const current: StaveOperationPhaseState =
        index === -1
          ? { phase: event.phase, startedAt: receivedAtMs, lines: [] }
          : state.phases[index]!;
      const finished: StaveOperationPhaseState = {
        ...current,
        finishedAt: receivedAtMs,
        durationMs: event.durationMs,
      };
      return {
        ...running,
        phases:
          index === -1 ? [...state.phases, finished] : replacePhase(state.phases, index, finished),
      };
    }
    case "finished":
      return { ...running, status: "finished", result: event.result };
    case "failed":
      return { ...running, status: "failed", error: event.error };
  }
}

/** The two operation streams, bound to an environment by the caller. */
export interface StaveOperationClient<E, R> {
  readonly runOperation: (
    environmentId: EnvironmentId,
    input: StaveRunOperationInput,
  ) => Stream.Stream<StaveProgressEvent, E, R>;
  readonly observeOperation: (
    environmentId: EnvironmentId,
    input: StaveObserveOperationInput,
  ) => Stream.Stream<StaveProgressEvent, E, R>;
}

export interface StaveOperationOutcome<R> {
  /** Final state for this stream: `finished`, `failed`, or `disconnected`. */
  readonly state: StaveOperationState;
  /**
   * Resumes a `disconnected` operation through `stave.observeOperation` from
   * `lastSequence`, keeping the retained phases. Calling it on a terminal
   * state returns the same outcome without touching the server.
   */
  readonly reattach: () => Effect.Effect<StaveOperationOutcome<R>, never, R>;
}

interface ConsumeInput<R> {
  readonly state: StaveOperationState;
  readonly starting: boolean;
  readonly onState: ((state: StaveOperationState) => void) | undefined;
  readonly observe: (state: StaveOperationState) => Stream.Stream<StaveProgressEvent, unknown, R>;
}

const isRejected = Schema.is(StaveOperationRejectedError);
const isAdmissionFailure = Schema.is(
  Schema.Union([
    StaveUnavailableError,
    StaveNotSpaceError,
    ServerSettingsError,
    EnvironmentAuthorizationError,
  ]),
);

function describeStreamFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "The operation stream ended unexpectedly.";
}

function markDisconnected(state: StaveOperationState, reason?: string): StaveOperationState {
  return {
    ...state,
    status: "disconnected",
    ...(reason === undefined ? {} : { disconnectReason: reason }),
  };
}

function markRejected(
  state: StaveOperationState,
  rejection: StaveOperationRejectedError,
): StaveOperationState {
  return {
    ...state,
    status: "failed",
    error: { code: rejection.code, message: rejection.message, details: null },
  };
}

/**
 * Drives one stream to its end. A terminal event settles the state; a stream
 * that closes or fails without one leaves it `disconnected` so the caller can
 * reattach, except an admission refusal (`StaveOperationRejectedError`),
 * which is a real failure.
 */
const consumeStaveOperationStream = <R>(
  stream: Stream.Stream<StaveProgressEvent, unknown, R>,
  input: ConsumeInput<R>,
): Effect.Effect<StaveOperationOutcome<R>, never, R> =>
  Effect.gen(function* () {
    let current: StaveOperationState = { ...input.state, status: "running" };
    const publish = (next: StaveOperationState) =>
      Effect.sync(() => {
        current = next;
        input.onState?.(next);
      });
    yield* publish(current);

    const ended = yield* stream.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const next = reduceStaveProgressEvent(current, event, now);
          if (next !== current) {
            yield* publish(next);
          }
        }),
      ),
      Effect.as<{ readonly failure: unknown } | null>(null),
      Effect.catch((failure) => Effect.succeed({ failure })),
    );

    if (!isStaveOperationTerminal(current.status)) {
      if (ended !== null && isRejected(ended.failure)) {
        yield* publish(markRejected(current, ended.failure));
      } else if (
        ended !== null &&
        input.starting &&
        current.lastSequence === null &&
        isAdmissionFailure(ended.failure)
      ) {
        yield* publish({
          ...current,
          status: "failed",
          error: { code: "unknown", message: ended.failure.message, details: null },
        });
      } else {
        yield* publish(
          markDisconnected(
            current,
            ended === null ? undefined : describeStreamFailure(ended.failure),
          ),
        );
      }
    }

    const settled = current;
    const reattach = (): Effect.Effect<StaveOperationOutcome<R>, never, R> =>
      isStaveOperationTerminal(settled.status)
        ? Effect.succeed({ state: settled, reattach })
        : consumeStaveOperationStream(input.observe(settled), {
            ...input,
            state: settled,
            starting: false,
          });
    return { state: settled, reattach };
  });

export interface RunStaveOperationInput<E, R> {
  readonly client: StaveOperationClient<E, R>;
  readonly environmentId: EnvironmentId;
  readonly operationId: string;
  readonly operation: StaveOperation;
  /** Resume cursor for start-or-attach; omit to start (or attach from the beginning). */
  readonly afterSequence?: number;
  /** Retained state to continue from (a previous `disconnected` outcome). */
  readonly initialState?: StaveOperationState;
  readonly onState?: (state: StaveOperationState) => void;
}

function observeFrom<E, R>(
  client: StaveOperationClient<E, R>,
  environmentId: EnvironmentId,
): (state: StaveOperationState) => Stream.Stream<StaveProgressEvent, E, R> {
  return (state) =>
    client.observeOperation(environmentId, {
      operationId: state.operationId,
      ...(state.lastSequence === null ? {} : { afterSequence: state.lastSequence }),
    });
}

/**
 * Starts (or attaches to) an operation through `stave.runOperation` and
 * follows it to a settled outcome. Never fails: admission refusals become a
 * `failed` state, transport loss a `disconnected` one with `reattach`.
 */
export function runStaveOperation<E, R>(
  input: RunStaveOperationInput<E, R>,
): Effect.Effect<StaveOperationOutcome<R>, never, R> {
  const state = input.initialState ?? initialStaveOperationState(input.operationId);
  return consumeStaveOperationStream(
    input.client.runOperation(input.environmentId, {
      operationId: input.operationId,
      operation: input.operation,
      ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
    }),
    {
      state,
      starting: input.initialState === undefined && input.afterSequence === undefined,
      onState: input.onState,
      observe: observeFrom(input.client, input.environmentId),
    },
  );
}

export interface ReattachStaveOperationInput<E, R> {
  readonly client: StaveOperationClient<E, R>;
  readonly environmentId: EnvironmentId;
  /** The retained state; its `lastSequence` is the resume cursor. */
  readonly state: StaveOperationState;
  readonly onState?: (state: StaveOperationState) => void;
}

/** Reattaches to a running operation after a reconnect (`stave.observeOperation`). */
export function reattachStaveOperation<E, R>(
  input: ReattachStaveOperationInput<E, R>,
): Effect.Effect<StaveOperationOutcome<R>, never, R> {
  const observe = observeFrom(input.client, input.environmentId);
  if (isStaveOperationTerminal(input.state.status)) {
    const outcome: StaveOperationOutcome<R> = {
      state: input.state,
      reattach: () => Effect.succeed(outcome),
    };
    return Effect.succeed(outcome);
  }
  return consumeStaveOperationStream(observe(input.state), {
    state: input.state,
    starting: false,
    onState: input.onState,
    observe,
  });
}

export interface StaveOperationRunInput {
  readonly environmentId: EnvironmentId;
  readonly operationId: string;
  readonly operation: StaveOperation;
  readonly afterSequence?: number;
}

export interface StaveOperationReattachInput {
  readonly environmentId: EnvironmentId;
  readonly operationId: string;
}

/**
 * Atom-backed manager: one state atom per `operationId`, a `run` command
 * (start-or-attach; a `disconnected` state is resumed rather than restarted)
 * and a `reattach` command for after a reconnect. Runs for the same id are
 * serialised so a retry never races the stream it is resuming.
 */
export function createStaveOperationManager<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const stateAtom = Atom.family((operationId: string) =>
    Atom.make(initialStaveOperationState(operationId)).pipe(
      Atom.keepAlive,
      Atom.withLabel(`stave-operation:${operationId}`),
    ),
  );

  const client: StaveOperationClient<unknown, EnvironmentRegistry> = {
    runOperation: (environmentId, input) =>
      runStreamInEnvironment(environmentId, runStream(WS_METHODS.staveRunOperation, input)),
    observeOperation: (environmentId, input) =>
      runStreamInEnvironment(environmentId, runStream(WS_METHODS.staveObserveOperation, input)),
  };

  const run = createRuntimeCommand<
    EnvironmentRegistry | R,
    E,
    StaveOperationRunInput,
    StaveOperationState,
    never
  >(runtime, {
    label: "stave-operation:run",
    concurrency: { mode: "serial", key: (input) => input.operationId },
    execute: (input, registry) => {
      const atom = stateAtom(input.operationId);
      const existing = registry.get(atom);
      const resuming = existing.status === "disconnected";
      const afterSequence =
        input.afterSequence ?? (resuming ? (existing.lastSequence ?? undefined) : undefined);
      return runStaveOperation({
        client,
        environmentId: input.environmentId,
        operationId: input.operationId,
        operation: input.operation,
        ...(afterSequence === undefined ? {} : { afterSequence }),
        ...(resuming ? { initialState: existing } : {}),
        onState: (state) => registry.set(atom, state),
      }).pipe(Effect.map((outcome) => outcome.state));
    },
  });

  const reattach = createRuntimeCommand<
    EnvironmentRegistry | R,
    E,
    StaveOperationReattachInput,
    StaveOperationState,
    never
  >(runtime, {
    label: "stave-operation:reattach",
    concurrency: { mode: "serial", key: (input) => input.operationId },
    execute: (input, registry) => {
      const atom = stateAtom(input.operationId);
      return reattachStaveOperation({
        client,
        environmentId: input.environmentId,
        state: registry.get(atom),
        onState: (state) => registry.set(atom, state),
      }).pipe(Effect.map((outcome) => outcome.state));
    },
  });

  return { stateAtom, run, reattach };
}
