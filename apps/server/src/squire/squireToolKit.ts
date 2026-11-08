/**
 * The kit's keyed writes stay idempotent: card, hold, and log rows commit with `tool.called` in one transaction.
 * Handlers register into `SquireToolRegistry` when their layer is built, so layer order does not matter.
 * @module squire/squireToolKit
 */
import type {
  SquireCardId,
  SquireCardOrigin,
  SquireId,
  SquireRole,
  ThreadId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import type { PersistenceSqlError } from "../persistence/Errors.ts";
import type * as SquireRepository from "./SquireRepository.ts";
import type { SquireScopeError } from "./SquireScope.ts";
import type * as squirePolicy from "./squirePolicy.ts";

export interface SquireToolResult {
  readonly isError: boolean;
  readonly text: string;
  readonly structuredContent?: unknown;
  /** MCP result `_meta`, passed through by the interceptor (MCP Apps). */
  readonly _meta?: Record<string, unknown>;
  /** Image content after the text (`html_preview`'s screenshot); never stored. */
  readonly image?: { readonly data: string; readonly mimeType: string };
}

/** MCP `Tool.Encoded`. */
export interface SquireToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
    readonly additionalProperties: boolean;
  };
}

export interface SquireToolCaller {
  readonly squireId: SquireId;
  readonly role: SquireRole;
  /** The Squire's home thread, whose active run is the call's run. */
  readonly threadId: ThreadId;
}

export interface SquireToolRun {
  readonly runId: string;
  readonly origin: SquireCardOrigin;
  /** The delivered batch the run answers; null for a user turn. */
  readonly batchId: string | null;
}

export interface SquireToolContext {
  readonly caller: SquireToolCaller;
  readonly squire: SquireRepository.SquireRow;
  readonly run: SquireToolRun;
  readonly tool: string;
  /** The invocation key. */
  readonly key: string;
  readonly args: unknown;
  readonly now: string;
}

export type SquireToolDecoded<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

export interface SquireToolKit {
  readonly ok: (text: string, structuredContent?: unknown) => SquireToolResult;
  readonly refused: (reason: string, text: string) => SquireToolResult;
  /** A keyed refusal: writes `tool.called`, and `decision.recorded` when `decision` is given. */
  readonly refuse: (
    ctx: SquireToolContext,
    reason: string,
    text: string,
    options?: {
      readonly threadId?: ThreadId | null;
      readonly decision?: Record<string, unknown>;
    },
  ) => Effect.Effect<SquireToolResult>;
  /** Runs inside the caller's transaction. */
  readonly logRow: (
    ctx: SquireToolContext,
    kind: string,
    data: Record<string, unknown>,
    extra?: {
      readonly threadId?: ThreadId | null;
      readonly cardId?: SquireCardId | null;
      readonly taskId?: string | null;
      readonly invocationKey?: string | null;
    },
  ) => Effect.Effect<number, PersistenceSqlError>;
  /**
   * One transaction: `body`, then `tool.called` with its result. After the
   * commit each `wake` id is woken through `SquireDelivery`.
   */
  readonly commit: <E, R>(
    ctx: SquireToolContext,
    threadId: ThreadId | null,
    body: Effect.Effect<
      { readonly result: SquireToolResult; readonly wake?: ReadonlyArray<SquireId> },
      E,
      R
    >,
  ) => Effect.Effect<SquireToolResult, E | PersistenceSqlError, R>;
  /** The run's delivered batch rows; empty for a user turn. */
  readonly batchEvents: (
    ctx: SquireToolContext,
  ) => Effect.Effect<ReadonlyArray<SquireRepository.SquireEventRow>, PersistenceSqlError>;
  /** Strips the `null`s models send for omitted optional arguments. */
  readonly decodeArgs: <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    args: unknown,
  ) => Effect.Effect<SquireToolDecoded<S["Type"]>>;
  /** Now plus the Squire's undo window. */
  readonly holdUntil: (ctx: SquireToolContext) => string;
  /** Whether the caller's Notify is On for this turn's origin. */
  readonly notifyOn: (ctx: SquireToolContext) => boolean;
  readonly policySquireOf: (row: SquireRepository.SquireRow) => squirePolicy.SquirePolicySquire;
  readonly budgetRowsOf: (
    squireId: SquireId,
    now: string,
  ) => Effect.Effect<ReadonlyArray<squirePolicy.SquirePolicyBudgetRow>, PersistenceSqlError>;
  readonly trackersFor: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<squirePolicy.SquirePolicyTracker>, SquireScopeError>;
}

export interface SquireToolHandler {
  readonly definition: SquireToolDefinition;
  readonly roles: ReadonlyArray<SquireRole>;
  /** Read handlers skip the per-Squire lock and the stored-result replay. */
  readonly read?: boolean;
  readonly call: (
    ctx: SquireToolContext,
    kit: SquireToolKit,
  ) => Effect.Effect<SquireToolResult, unknown>;
}

export class SquireToolRegistry extends Context.Service<
  SquireToolRegistry,
  {
    readonly register: (handlers: ReadonlyArray<SquireToolHandler>) => Effect.Effect<void>;
    readonly get: (name: string) => Option.Option<SquireToolHandler>;
    readonly forRole: (role: SquireRole) => ReadonlyArray<SquireToolHandler>;
  }
  // @effect-diagnostics-next-line deterministicKeys:off -- the seam's fixed tag, shared by every feature layer.
>()("lecturn/squire/SquireToolRegistry") {}

const makeRegistry = Effect.sync(() => {
  const handlers = new Map<string, SquireToolHandler>();
  return SquireToolRegistry.of({
    register: Effect.fn("SquireToolRegistry.register")(function (added) {
      return Effect.sync(() => {
        for (const handler of added) handlers.set(handler.definition.name, handler);
      });
    }),
    get: (name) => Option.fromNullishOr(handlers.get(name)),
    forRole: (role) => [...handlers.values()].filter((handler) => handler.roles.includes(role)),
  });
});

export const layer = Layer.effect(SquireToolRegistry, makeRegistry);
