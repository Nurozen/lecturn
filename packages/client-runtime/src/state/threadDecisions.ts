import {
  WS_METHODS,
  ProjectId as ProjectIdSchema,
  DecisionRevision,
  ThreadDecision as ThreadDecisionSchema,
  type ThreadDecisionExportResult,
  type EnvironmentId,
  type ProjectId,
  type ThreadDecision,
  type ThreadDecisionListInput,
  type DecisionProcessingStatus,
} from "@lecturn/contracts";
import { formatAssistantCitationHref } from "@lecturn/shared/assistantCitations";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function decisionStatusLabel(status: DecisionProcessingStatus): string {
  if (status.paused) return "Paused for this thread";
  const reason = status.blockedReason;
  if (reason)
    return (
      {
        disabled: "Tracking is off",
        unfunded: "Membership funding required",
        "access-expired": "Membership access expired",
        "allowance-exhausted": "Allowance exhausted",
        "provider-unsupported": "Writer not supported",
        "provider-unavailable": "Waiting for your agent",
        "detector-unavailable": "Detection paused — retry when the service is available",
        "provider-foreground": "Waiting for your conversation to finish",
        "provider-changed": "Agent configuration changed",
        "host-policy": "Waiting for host power policy",
        paused: "Paused",
        "source-changed": "Conversation changed",
        budget: "Analysis limit reached",
        error: "Service unavailable",
      } as const
    )[reason];
  return (
    {
      idle: "Tracking ready",
      running: "Finding decisions",
      waiting: "Waiting for your agent",
      incomplete: "Some conversation remains unprocessed",
      failed: "Processing needs attention",
    } as const
  )[status.state];
}

/** Every filter and page participates in the key; no project or environment can share data. */
export function threadDecisionListKey(
  environmentId: EnvironmentId,
  input: ThreadDecisionListInput,
) {
  return {
    environmentId,
    input: {
      projectId: input.projectId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.search?.trim() ? { search: input.search.trim() } : {}),
      ...(input.reviewState === undefined ? {} : { reviewState: input.reviewState }),
      lifecycle: input.lifecycle ?? "current",
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      limit: input.limit ?? 50,
    },
  };
}
export function decisionToMarkdown(
  decision: ThreadDecision,
  environmentId?: EnvironmentId,
): string {
  return [
    `## ${decision.title}`,
    decision.body,
    ...(decision.rationale ? [`Rationale: ${decision.rationale}`] : []),
    `Attribution: ${decision.attribution} · Review: ${decision.reviewState} · ${decision.lifecycle}`,
    ...decision.evidence.map(
      (evidence) =>
        `> ${evidence.quote.replace(/\n/g, "\n> ")}\n\nSource: ${environmentId ? `[${evidence.messageRole} message](${formatAssistantCitationHref({ version: 1, coordinateSpace: "raw-message", environmentId, threadId: evidence.threadId, messageId: evidence.messageId, text: evidence.quote, start: evidence.start, end: evidence.end, prefix: "", suffix: "" })})` : `${evidence.threadId} / ${evidence.messageId}`} (${evidence.availability})`,
    ),
    ...(decision.comment ? [`Personal comment: ${decision.comment}`] : []),
  ].join("\n\n");
}
const decodeDecisionExportPage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      schemaVersion: Schema.Literal(1),
      projectId: ProjectIdSchema,
      projectRevision: DecisionRevision,
      decisions: Schema.Array(ThreadDecisionSchema),
    }),
  ),
);
const encodeDecisionExport = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeScopeKey = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);
/** Merge a complete, revision-consistent export into one portable document. */
export function assembleDecisionJsonExport(
  projectId: ProjectId,
  pages: readonly ThreadDecisionExportResult[],
): string {
  if (!pages.length) throw new Error("Decision export has no pages.");
  const revision = pages[0]!.projectRevision;
  const notes: ThreadDecision[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  for (const [index, page] of pages.entries()) {
    if (page.format !== "json" || page.schemaVersion !== 1 || page.projectRevision !== revision)
      throw new Error("Decision export changed while reading. Refresh and try again.");
    if ((index === pages.length - 1) !== (page.nextCursor === null))
      throw new Error("Decision export is incomplete.");
    if (page.nextCursor) {
      if (cursors.has(page.nextCursor)) throw new Error("Decision export did not advance.");
      cursors.add(page.nextCursor);
    }
    const decoded = decodeDecisionExportPage(page.content);
    if (decoded.projectId !== projectId || decoded.projectRevision !== revision)
      throw new Error("Decision export scope does not match.");
    for (const note of decoded.decisions) {
      if (note.projectId !== projectId || ids.has(note.id))
        throw new Error("Decision export contains an invalid or repeated decision.");
      ids.add(note.id);
      notes.push(note);
    }
  }
  return encodeDecisionExport({
    schemaVersion: 1,
    projectId,
    projectRevision: revision,
    decisions: notes,
  });
}
export function createThreadDecisionEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const changes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "decisions:changes",
    tag: WS_METHODS.threadDecisionsSubscribe,
    transform: (stream) =>
      stream.pipe(
        Stream.scan(new Map<ProjectId, number>(), (previous, event) => {
          const next = new Map(previous);
          next.set(event.projectId, event.revision);
          return next;
        }),
      ),
  });
  const manualRefresh = Atom.family((key: string) =>
    Atom.make(0).pipe(Atom.withLabel(`decisions:refresh:${key}`)),
  );
  const scopeKey = (environmentId: EnvironmentId, projectId: ProjectId) =>
    JSON.stringify([environmentId, projectId]);
  const refresh = Atom.family((key: string) =>
    Atom.make((get) => {
      const [environmentId, projectId] = decodeScopeKey(key) as [EnvironmentId, ProjectId];
      const revisions = Option.getOrNull(
        AsyncResult.value(get(changes({ environmentId, input: {} }))),
      );
      return `${get(manualRefresh(key))}:${revisions?.get(projectId) ?? 0}`;
    }),
  );
  const refreshTrigger = ({
    environmentId,
    input,
  }: {
    environmentId: EnvironmentId;
    input: { projectId: ProjectId };
  }) => refresh(scopeKey(environmentId, input.projectId));
  const listQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "decisions:list",
    tag: WS_METHODS.threadDecisionsList,
    staleTimeMs: 15_000,
    refreshTrigger,
  });
  const options = {
    scheduler: createAtomCommandScheduler(),
    concurrency: {
      mode: "serial",
      key: ({
        environmentId,
        input,
      }: {
        environmentId: EnvironmentId;
        input: { projectId: ProjectId };
      }) => scopeKey(environmentId, input.projectId),
    },
    onSuccess: (
      { environmentId, input }: { environmentId: EnvironmentId; input: { projectId: ProjectId } },
      registry: AtomRegistry.AtomRegistry,
    ) =>
      Effect.sync(() =>
        registry.update(manualRefresh(scopeKey(environmentId, input.projectId)), (n) => n + 1),
      ),
  } as const;
  const fundingRefresh = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`decisions:funding-refresh:${environmentId}`)),
  );
  return {
    fundingStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "decisions:funding-status",
      tag: WS_METHODS.threadDecisionsFundingStatus,
      staleTimeMs: 0,
      refreshTrigger: ({ environmentId }) => fundingRefresh(environmentId),
    }),
    funding: createEnvironmentRpcCommand(runtime, {
      label: "decisions:funding",
      tag: WS_METHODS.threadDecisionsFunding,
      scheduler: createAtomCommandScheduler(),
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.update(fundingRefresh(environmentId), (n) => n + 1)),
    }),
    changes,
    list: (target: { environmentId: EnvironmentId; input: ThreadDecisionListInput }) =>
      listQuery(threadDecisionListKey(target.environmentId, target.input)),
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "decisions:get",
      tag: WS_METHODS.threadDecisionsGet,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "decisions:status",
      tag: WS_METHODS.threadDecisionsStatus,
      staleTimeMs: 15_000,
      refreshTrigger,
    }),
    sourceWindow: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "decisions:source",
      tag: WS_METHODS.threadDecisionsSourceWindow,
      staleTimeMs: 0,
      refreshTrigger,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "decisions:mutate",
      tag: WS_METHODS.threadDecisionsMutate,
    }),
    settings: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "decisions:settings",
      tag: WS_METHODS.threadDecisionsSettings,
    }),
    scan: createEnvironmentRpcCommand(runtime, {
      ...options,
      label: "decisions:scan",
      tag: WS_METHODS.threadDecisionsScan,
    }),
    export: createEnvironmentRpcCommand(runtime, {
      label: "decisions:export",
      tag: WS_METHODS.threadDecisionsExport,
    }),
  };
}
