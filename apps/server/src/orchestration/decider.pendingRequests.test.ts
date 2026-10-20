import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThreadActivity,
} from "@lecturn/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const commands = [
  {
    type: "thread.settle",
    commandId: CommandId.make("cmd-settle"),
    threadId,
  },
  {
    type: "thread.snooze",
    commandId: CommandId.make("cmd-snooze"),
    threadId,
    // Effect's test clock is pinned to the epoch.
    snoozedUntil: "1970-01-02T09:00:00.000Z",
  },
] as const;

const requestKinds = [
  {
    kind: "approval",
    otherKind: "user-input",
    staleDetails: [
      "stale pending approval request",
      "unknown pending approval request",
      "unknown pending permission request",
      "unknown pending Codex approval request",
    ],
  },
  {
    kind: "user-input",
    otherKind: "approval",
    staleDetails: [
      "stale pending user-input request",
      "unknown pending user-input request",
      "unknown pending user input request",
      "unknown pending Codex user input request",
    ],
  },
] as const;

function activity(kind: string, requestId: string, detail?: string): OrchestrationThreadActivity {
  return {
    id: EventId.make(`activity-${kind}-${requestId}`),
    tone: "approval",
    kind,
    summary: kind,
    payload: {
      requestId,
      ...(detail === undefined ? {} : { detail }),
      ...(kind === "user-input.requested"
        ? {
            questions: [
              {
                id: "question-1",
                header: "Next step",
                question: "How should we continue?",
                options: [],
                multiSelect: false,
                allowCustomAnswer: true,
              },
            ],
          }
        : {}),
    },
    turnId: null,
    createdAt: kind.endsWith(".requested")
      ? "2026-01-01T00:00:02.000Z"
      : "2026-01-01T00:00:01.000Z",
  };
}

function makeReadModel(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        pullRequests: [],
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities,
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

function activityOrders(
  requested: OrchestrationThreadActivity,
  terminal: OrchestrationThreadActivity,
) {
  return [
    [requested, terminal],
    [terminal, requested],
    [requested, terminal, { ...requested, id: EventId.make(`${requested.id}-replayed`) }],
    [
      terminal,
      requested,
      { ...terminal, id: EventId.make(`${terminal.id}-replayed`) },
      { ...requested, id: EventId.make(`${requested.id}-replayed`) },
    ],
  ];
}

it.layer(NodeServices.layer)("pending request decider", (it) => {
  it.effect("message-mode questions cannot overwrite an approval with the same ID", () =>
    Effect.gen(function* () {
      const approval = activity("approval.requested", "same");
      const question = {
        ...activity("user-input.requested", "same"),
        payload: { requestId: "same", responseMode: "message" },
      };
      const settle = commands[0];
      for (const activities of [
        [approval, question],
        [question, approval],
        [approval, activity("user-input.resolved", "same"), question],
      ]) {
        const error = yield* decideOrchestrationCommand({
          command: settle,
          readModel: makeReadModel(activities),
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "OrchestrationThreadSettleBlockedError" });
      }
      for (const activities of activityOrders(approval, activity("approval.resolved", "same"))) {
        const result = yield* decideOrchestrationCommand({
          command: settle,
          readModel: makeReadModel([...activities, question]),
        });
        const events = Array.isArray(result) ? result : [result];
        expect(events.map((event) => event.type)).toEqual([
          "thread.settled",
          "thread.activity-appended",
        ]);
        expect(events[1]?.payload).toMatchObject({
          activity: {
            kind: "user-input.resolved",
            payload: { requestId: "same", responseMode: "message" },
          },
        });
      }
      for (const activities of activityOrders(question, activity("user-input.resolved", "same"))) {
        const result = yield* decideOrchestrationCommand({
          command: settle,
          readModel: makeReadModel(activities),
        });
        expect((Array.isArray(result) ? result : [result]).map((event) => event.type)).toEqual([
          "thread.settled",
        ]);
      }
    }),
  );
  for (const command of commands) {
    const expectedEvent = command.type === "thread.settle" ? "thread.settled" : "thread.snoozed";
    const expectedError =
      command.type === "thread.settle"
        ? { _tag: "OrchestrationThreadSettleBlockedError", threadId }
        : {
            _tag: "OrchestrationCommandInvariantError",
            commandType: command.type,
            detail: `thread ${threadId} has a pending approval or user-input request and cannot be snoozed`,
          };

    for (const { kind, otherKind, staleDetails } of requestKinds) {
      it.effect(`${command.type} accepts reordered and replayed resolved ${kind} requests`, () =>
        Effect.gen(function* () {
          for (const activities of activityOrders(
            activity(`${kind}.requested`, "req-1"),
            activity(`${kind}.resolved`, "req-1"),
          )) {
            const result = yield* decideOrchestrationCommand({
              command,
              readModel: makeReadModel(activities),
            });
            const events = Array.isArray(result) ? result : [result];
            expect(events.map((event) => event.type)).toEqual([expectedEvent]);
          }
        }),
      );

      for (const detail of staleDetails) {
        it.effect(
          `${command.type} treats ${detail} as terminal in either order and on replay`,
          () =>
            Effect.gen(function* () {
              for (const activities of activityOrders(
                activity(`${kind}.requested`, "req-1"),
                activity(`provider.${kind}.respond.failed`, "req-1", `${detail} req-1`),
              )) {
                const result = yield* decideOrchestrationCommand({
                  command,
                  readModel: makeReadModel(activities),
                });
                const events = Array.isArray(result) ? result : [result];
                expect(events.map((event) => event.type)).toEqual([expectedEvent]);
              }
            }),
        );
      }

      it.effect(`${command.type} rejects transient ${kind} failures in either order`, () =>
        Effect.gen(function* () {
          for (const activities of activityOrders(
            activity(`${kind}.requested`, "req-1"),
            activity(`provider.${kind}.respond.failed`, "req-1", "provider connection reset"),
          )) {
            const error = yield* decideOrchestrationCommand({
              command,
              readModel: makeReadModel(activities),
            }).pipe(Effect.flip);
            expect(error).toMatchObject(expectedError);
          }
        }),
      );

      it.effect(`${command.type} still rejects a distinct open ${kind} request`, () =>
        Effect.gen(function* () {
          for (const terminal of [
            activity(`${kind}.resolved`, "req-1"),
            activity(`provider.${kind}.respond.failed`, "req-1", staleDetails[0]),
          ]) {
            for (const activities of activityOrders(
              activity(`${kind}.requested`, "req-1"),
              terminal,
            )) {
              const error = yield* decideOrchestrationCommand({
                command,
                readModel: makeReadModel([activity(`${kind}.requested`, "req-2"), ...activities]),
              }).pipe(Effect.flip);
              expect(error).toMatchObject(expectedError);
            }
          }
        }),
      );

      it.effect(
        `${command.type} does not close ${kind} when the same ID closes as ${otherKind}`,
        () =>
          Effect.gen(function* () {
            const otherStaleDetail = requestKinds.find((entry) => entry.kind === otherKind)!
              .staleDetails[0];
            for (const terminal of [
              activity(`${otherKind}.resolved`, "req-1"),
              activity(`provider.${otherKind}.respond.failed`, "req-1", otherStaleDetail),
            ]) {
              for (const activities of activityOrders(
                activity(`${kind}.requested`, "req-1"),
                terminal,
              )) {
                const error = yield* decideOrchestrationCommand({
                  command,
                  readModel: makeReadModel(activities),
                }).pipe(Effect.flip);
                expect(error).toMatchObject(expectedError);
              }
            }
          }),
      );

      it.effect(`${command.type} keeps ${kind} open for a failure about ${otherKind}`, () =>
        Effect.gen(function* () {
          const otherStaleDetail = requestKinds.find((entry) => entry.kind === otherKind)!
            .staleDetails[0];
          for (const activities of activityOrders(
            activity(`${kind}.requested`, "req-1"),
            activity(`provider.${kind}.respond.failed`, "req-1", otherStaleDetail),
          )) {
            const error = yield* decideOrchestrationCommand({
              command,
              readModel: makeReadModel(activities),
            }).pipe(Effect.flip);
            expect(error).toMatchObject(expectedError);
          }
        }),
      );
    }
  }
});
