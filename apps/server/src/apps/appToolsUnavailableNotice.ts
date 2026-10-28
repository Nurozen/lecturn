/**
 * An app thread whose provider thread did not get Lecturn's MCP server (or
 * lost it at startup) cannot reach the app's tools, so the thread says so
 * instead of the agent failing silently.
 *
 * Shown once per thread and provider thread: a provider switch is a new
 * provider thread with its own chance to fail, while a repeated report for
 * the same one (every turn on an external OpenCode server) is the same fact.
 */
import {
  EventId,
  PROVIDER_DISPLAY_NAMES,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type ProviderThreadId,
  type ThreadId,
  TurnItemId,
} from "@lecturn/contracts";
import type { McpActivationSignal } from "@lecturn/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { EventSinkV2Shape } from "../orchestration-v2/EventSink.ts";
import type { ProjectionStoreV2Shape } from "../orchestration-v2/ProjectionStore.ts";

const appToolsUnavailableMessage = (appName: string, providerName: string) =>
  `${appName} tools unavailable with ${providerName}`;

/** Derived, so a restarted server finds the notice it already wrote. */
const appToolsUnavailableNoticeId = (threadId: ThreadId, providerThreadId: ProviderThreadId) =>
  TurnItemId.make(`turn-item:apps:tools-unavailable:${threadId}:${providerThreadId}`);

const isUnavailable = (signal: McpActivationSignal) =>
  signal.type === "mcp-activation-failed" || !signal.mcpActivated;

/**
 * The caller handles signals one at a time, so the in-memory set cannot race
 * itself; the derived item id covers what the set lost in a restart.
 */
export const makeAppToolsUnavailableNotices = (deps: {
  readonly threads: Pick<
    ProjectionStoreV2Shape,
    "getThread" | "getTurnItem" | "getNextTurnItemOrdinal"
  >;
  readonly eventSink: Pick<EventSinkV2Shape, "write">;
  /** The granted app owning the project, by name; `None` for any other project. */
  readonly grantedAppName: (projectId: ProjectId) => Effect.Effect<Option.Option<string>>;
}) => {
  const seen = new Set<string>();
  return (signal: McpActivationSignal): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!isUnavailable(signal)) return;
      const key = `${signal.threadId}\u0000${signal.providerThreadId}`;
      if (seen.has(key)) return;
      const thread = yield* deps.threads.getThread(signal.threadId);
      const appName = yield* deps.grantedAppName(thread.projectId);
      if (Option.isNone(appName)) return;
      const id = appToolsUnavailableNoticeId(signal.threadId, signal.providerThreadId);
      if ((yield* deps.threads.getTurnItem({ threadId: signal.threadId, itemId: id })) !== null) {
        seen.add(key);
        return;
      }
      const message = appToolsUnavailableMessage(
        appName.value,
        PROVIDER_DISPLAY_NAMES[signal.driver] ?? signal.driver,
      );
      const now = yield* DateTime.now;
      const item: OrchestrationV2TurnItem = {
        id,
        threadId: signal.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: signal.providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* deps.threads.getNextTurnItemOrdinal(signal.threadId),
        type: "system_notice",
        status: "completed",
        title: message,
        message,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      yield* deps.eventSink.write({
        events: [
          {
            id: EventId.make(
              `apps:tools-unavailable:${signal.threadId}:${signal.providerThreadId}`,
            ),
            type: "turn-item.updated",
            threadId: signal.threadId,
            driver: signal.driver,
            occurredAt: now,
            payload: item,
          },
        ],
      });
      seen.add(key);
    }).pipe(
      // A notice that cannot be written must never take the signal stream down.
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not show that app tools are unavailable", {
          threadId: signal.threadId,
          cause,
        }),
      ),
    );
};
