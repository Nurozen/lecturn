import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2StoredEvent,
  ProjectId,
  RunId,
  ThreadId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import {
  layer,
  LecturnHookRejectedError,
  LecturnOrchestrationHooks,
  type LecturnThreadLifecycleNotice,
  noop,
  resolve,
  threadLifecycleNotices,
} from "./LecturnOrchestrationHooks.ts";

const threadId = ThreadId.make("thread:hooks");
const command = { type: "thread.archive", commandId: CommandId.make("cmd"), threadId } as const;
const turnInput = {
  thread: { id: threadId } as never,
  run: { id: RunId.make("run:1") } as never,
  message: { id: MessageId.make("message:1") } as never,
  compaction: false,
};

describe("LecturnOrchestrationHooks", () => {
  it.effect("is a no-op when absent or empty", () =>
    Effect.gen(function* () {
      const absent = yield* resolve;
      assert.strictEqual(absent, noop);
      assert.equal(yield* absent.aroundCommand({ scope: "thread", command }, Effect.succeed(1)), 1);
      assert.deepEqual(yield* absent.beforeTurnStart(turnInput), {});
      const empty = yield* Effect.provide(resolve, layer);
      assert.equal(yield* empty.aroundCommand({ scope: "thread", command }, Effect.succeed(2)), 2);
      assert.deepEqual(yield* empty.beforeTurnStart(turnInput), {});
    }),
  );

  it.effect("wraps commands outermost-first and propagates rejections", () =>
    Effect.gen(function* () {
      const hooks = yield* LecturnOrchestrationHooks;
      const order: Array<string> = [];
      const scope = yield* Scope.make();
      yield* hooks
        .register({
          name: "outer",
          aroundCommand: (_input, commit) =>
            Effect.sync(() => order.push("outer:before")).pipe(
              Effect.andThen(commit),
              Effect.tap(() => Effect.sync(() => order.push("outer:after"))),
            ),
        })
        .pipe(Scope.provide(scope));
      yield* hooks
        .register({
          name: "inner",
          aroundCommand: (input, commit) =>
            input.scope === "project"
              ? Effect.fail(
                  new LecturnHookRejectedError({
                    hook: "aroundCommand",
                    contribution: "inner",
                    reason: "A Stave operation is changing this space.",
                  }),
                )
              : Effect.sync(() => order.push("inner")).pipe(Effect.andThen(commit)),
        })
        .pipe(Scope.provide(scope));
      const result = yield* hooks.aroundCommand(
        { scope: "thread", command },
        Effect.sync(() => {
          order.push("commit");
          return "ok";
        }),
      );
      assert.equal(result, "ok");
      assert.deepEqual(order, ["outer:before", "inner", "commit", "outer:after"]);
      const rejected = yield* Effect.flip(
        hooks.aroundCommand(
          {
            scope: "project",
            command: {
              type: "project.refresh",
              commandId: CommandId.make("cmd-refresh"),
              projectId: ProjectId.make("project-1"),
            },
          },
          Effect.succeed("never"),
        ),
      );
      assert.equal(rejected._tag, "LecturnHookRejectedError");
      assert.equal(rejected.message, "A Stave operation is changing this space.");
      // Closing the registering scope removes both contributions.
      yield* Scope.close(scope, Exit.void);
      order.length = 0;
      yield* hooks.aroundCommand({ scope: "thread", command }, Effect.void);
      assert.deepEqual(order, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("joins context prefixes and fails the turn on rejection", () =>
    Effect.gen(function* () {
      const hooks = yield* LecturnOrchestrationHooks;
      yield* hooks.register({
        name: "a",
        beforeTurnStart: () => Effect.succeed({ contextPrefix: "A" }),
      });
      yield* hooks.register({
        name: "blank",
        beforeTurnStart: () => Effect.succeed({ contextPrefix: " " }),
      });
      yield* hooks.register({ name: "none", beforeTurnStart: () => Effect.void });
      yield* hooks.register({
        name: "b",
        beforeTurnStart: () => Effect.succeed({ contextPrefix: "B" }),
      });
      assert.deepEqual(yield* hooks.beforeTurnStart(turnInput), { contextPrefix: "A\n\nB" });
      yield* hooks.register({
        name: "policy",
        beforeTurnStart: () =>
          Effect.fail(
            new LecturnHookRejectedError({
              hook: "beforeTurnStart",
              contribution: "policy",
              reason: "Provider 'codex' is disabled by your organization.",
            }),
          ),
      });
      const rejected = yield* Effect.flip(hooks.beforeTurnStart(turnInput));
      assert.equal(rejected.reason, "Provider 'codex' is disabled by your organization.");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("delivers notices and swallows contribution failures", () =>
    Effect.gen(function* () {
      const hooks = yield* LecturnOrchestrationHooks;
      const seen: Array<LecturnThreadLifecycleNotice["kind"] | string> = [];
      yield* hooks.register({
        name: "broken",
        onRunTerminal: () => Effect.die("boom"),
        onThreadLifecycle: () => Effect.die("boom"),
      });
      yield* hooks.register({
        name: "relay",
        onRunTerminal: (notice) => Effect.sync(() => void seen.push(`run:${notice.status}`)),
        onThreadLifecycle: (notice) => Effect.sync(() => void seen.push(notice.kind)),
      });
      yield* hooks.onRunTerminal({
        threadId,
        runId: RunId.make("run:1"),
        status: "completed",
        sequence: 7,
        reconciled: false,
      });
      yield* hooks.afterCommit({ command, storedEvents: [] });
      yield* hooks.afterCommit({
        command: {
          type: "thread.visit",
          commandId: CommandId.make("cmd-visit"),
          threadId,
        } as never,
        storedEvents: [],
      });
      assert.deepEqual(seen, ["run:completed", "archived"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("threadLifecycleNotices", () => {
  const stored = (event: object) =>
    ({
      sequence: 1,
      commandId: CommandId.make("cmd"),
      event,
    }) as unknown as OrchestrationV2StoredEvent;
  it("marks fork children as never raising a relay alert", () => {
    const targetThreadId = ThreadId.make("thread:child");
    const notices = threadLifecycleNotices({
      command: {
        type: "thread.fork",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("cmd-fork"),
        sourceThreadId: threadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        sourceMessageId: MessageId.make("message:1"),
      },
      storedEvents: [
        stored({
          id: EventId.make("event:1"),
          type: "thread.created",
          threadId: targetThreadId,
          payload: { projectId: ProjectId.make("project-1") },
        }),
      ],
    });
    assert.deepEqual(notices, [
      {
        kind: "forked",
        threadId: targetThreadId,
        projectId: ProjectId.make("project-1"),
        sourceThreadId: threadId,
        sourceMessageId: MessageId.make("message:1"),
        relayAlert: false,
      },
    ]);
  });
  it("reports imports only when the thread.imported event committed", () => {
    const importCommand = {
      type: "thread.import",
      commandId: CommandId.make("cmd-import"),
      threadId,
      projectId: ProjectId.make("project-1"),
    } as never;
    assert.deepEqual(threadLifecycleNotices({ command: importCommand, storedEvents: [] }), []);
    const importedFrom = { sessionId: "external" };
    assert.deepEqual(
      threadLifecycleNotices({
        command: importCommand,
        storedEvents: [stored({ type: "thread.imported", threadId, payload: { importedFrom } })],
      }),
      [
        {
          kind: "imported",
          threadId,
          projectId: ProjectId.make("project-1"),
          importedFrom,
        } as never,
      ],
    );
    assert.deepEqual(
      threadLifecycleNotices({
        command: { type: "thread.delete", commandId: CommandId.make("cmd-del"), threadId },
        storedEvents: [],
      }),
      [{ kind: "deleted", threadId }],
    );
  });
});

// Layer composition used by s-surface: a registration layer resolves the same registry.
describe("registration layers", () => {
  it.effect("share the registry provided outermost", () =>
    Effect.gen(function* () {
      const hooks = yield* LecturnOrchestrationHooks;
      assert.deepEqual(yield* hooks.beforeTurnStart(turnInput), { contextPrefix: "from-layer" });
    }).pipe(
      Effect.provide(
        Layer.effectDiscard(
          Effect.gen(function* () {
            const hooks = yield* LecturnOrchestrationHooks;
            yield* hooks.register({
              name: "contextual",
              beforeTurnStart: () => Effect.succeed({ contextPrefix: "from-layer" }),
            });
          }),
        ).pipe(Layer.provideMerge(layer)),
      ),
    ),
  );
});
