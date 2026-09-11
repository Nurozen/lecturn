// @effect-diagnostics nodeBuiltinImport:off -- deterministic fingerprints
import * as NodeCrypto from "node:crypto";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  SagaWorkbenchInferenceResult,
  type ModelSelection,
  type MessageId,
  type OrchestrationEvent,
  type ThreadId,
  type SagaWorkbenchConfigureInput,
  SagaWorkbenchError,
  type ProjectId,
  type SagaWorkbenchApproveInput,
  type SagaWorkbenchEvidence as Evidence,
  type SagaWorkbenchIdentity,
  type SagaWorkbenchMutationInput,
  type SagaWorkbenchRequirement,
  type SagaWorkbenchSnapshot,
  type SagaWorkbenchStageInput,
  type SagaWorkbenchWorkflow,
} from "@t3tools/contracts";
import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
} from "effect";
import { ServerConfig } from "../config.ts";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SagaWorkbenchRepository } from "../persistence/Services/SagaWorkbenchRepository.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { resolveSagaInferenceModel } from "./sagaInferenceModel.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { SagaWorkbenchEvidence } from "./SagaWorkbenchEvidence.ts";
import { archiveEntriesMatching } from "./StaveOperations.ts";
import { StaveSpaceLock } from "./StaveSpaceLock.ts";
import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";
import { StaveRpcRuntime } from "./staveRpcHandlers.ts";

const fingerprint = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (message: string, code: SagaWorkbenchError["code"] = "blocked") =>
  new SagaWorkbenchError({ code, message });
const isWorkbenchError = Schema.is(SagaWorkbenchError);
const encodeInput = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      priorSummary: Schema.NullOr(Schema.String),
      turns: Schema.Array(Schema.Struct({ question: Schema.String, response: Schema.String })),
    }),
  ),
);
const decodeInference = Schema.decodeUnknownEffect(SagaWorkbenchInferenceResult);
const boundary = (error: unknown) =>
  isWorkbenchError(error)
    ? error
    : fail("Workbench information is currently unavailable.", "unavailable");
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const requirementRevision = (row: SagaWorkbenchRequirement) => [
  row.key,
  row.kind,
  row.provider,
  row.host,
  row.repository,
  row.number,
  row.headRevision,
  row.localHeadRevision,
  row.kind === "no-changes" ? row.baseRevision : null,
];
export function approvalBlockers(evidence: Evidence): string[] {
  // Row messages include later delivery gates (CI and merge). Approval records a
  // judgment of identified revisions; typed local/identity fields gate it below.
  const rowMessages = new Set(
    evidence.requirements.flatMap((row) =>
      row.blockers.map((message) => `${row.repoName}: ${message}`),
    ),
  );
  const blockers = evidence.blockers.filter((message) => !rowMessages.has(message));
  if (!evidence.complete) blockers.push("Repository evidence is incomplete.");
  if (new Set(evidence.requirements.map((row) => row.key)).size !== evidence.requirements.length)
    blockers.push("Repository evidence has ambiguous requirements.");
  for (const row of evidence.requirements) {
    if (
      row.kind === "unknown" ||
      !row.host ||
      !row.repository ||
      !row.provider ||
      row.provider === "unknown" ||
      row.localChanges !== "clean" ||
      !row.localHeadRevision
    )
      blockers.push(
        `${row.repoName}: repository identity or local revision is not verified clean.`,
      );
    if (
      row.kind === "pull-request" &&
      (!row.number || !row.headRevision || row.localHeadMatches !== true)
    )
      blockers.push(`${row.repoName}: a current pushed pull request revision is required.`);
    if (row.kind === "no-changes" && (!row.baseRevision || row.localHeadMatches !== true))
      blockers.push(`${row.repoName}: no-change proof is unavailable.`);
  }
  return [...new Set(blockers)];
}
export function completionBlockers(
  evidence: Evidence,
  accepted: SagaWorkbenchWorkflow["accepted"],
): string[] {
  const blockers = [
    ...approvalBlockers(evidence),
    ...evidence.blockers,
    ...evidence.requirements.flatMap((row) =>
      row.blockers.map((message) => `${row.repoName}: ${message}`),
    ),
  ];
  if (!accepted) return [...blockers, "Explicit acceptance is required."];
  if (
    accepted.manifestRevision !== evidence.manifestRevision ||
    fingerprint(accepted.requirements.map(requirementRevision).sort()) !==
      fingerprint(evidence.requirements.map(requirementRevision).sort())
  )
    blockers.push(
      "Accepted repository revisions have changed. Review and accept the current revisions.",
    );
  for (const row of evidence.requirements) {
    if (row.kind !== "pull-request") continue;
    if (
      (row.requiredChecks !== "passing" && row.requiredChecks !== "none") ||
      row.checksRevision !== row.headRevision
    )
      blockers.push(
        `${row.repoName}: required CI is not verified clean for the accepted revision.`,
      );
    if (row.merged !== true || row.mergedSourceRevision !== row.headRevision)
      blockers.push(`${row.repoName}: merge of the accepted source revision is not verified.`);
  }
  return [...new Set(blockers)];
}
const refuseBlockers = (blockers: readonly string[]) =>
  blockers.length
    ? Effect.fail(new SagaWorkbenchError({ code: "blocked", message: blockers[0]!, blockers }))
    : Effect.void;

export type PromptInferenceEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;
export interface SagaInferenceRequest {
  readonly identity: SagaWorkbenchIdentity;
  readonly threadId: ThreadId;
  readonly beforeMessageId?: MessageId;
  readonly modelSelection: ModelSelection;
  readonly turns: readonly { readonly question: string; readonly response: string }[];
  readonly eventId: string;
  readonly sequence: number;
}
const inferenceActor = {
  subject: "system:saga-inference",
  sessionId: AuthSessionId.make("system:saga-inference"),
  scopes: [AuthOrchestrationOperateScope],
};

type Actor = Pick<AuthenticatedSession, "subject" | "sessionId" | "scopes">;
export class SagaWorkbenchService extends Context.Service<
  SagaWorkbenchService,
  {
    getSnapshot: (input: {
      projectId: ProjectId;
    }) => Effect.Effect<SagaWorkbenchSnapshot, SagaWorkbenchError>;
    getEvidence: (input: {
      identity: SagaWorkbenchIdentity;
    }) => Effect.Effect<Evidence, SagaWorkbenchError>;
    getActivity: (input: {
      identity: SagaWorkbenchIdentity;
    }) => ReturnType<SagaWorkbenchRepository["Service"]["activity"]>;
    preparePromptInference: (
      event: PromptInferenceEvent,
    ) => Effect.Effect<SagaInferenceRequest | null, SagaWorkbenchError>;
    inferFromPrompt: (
      input: SagaInferenceRequest,
    ) => Effect.Effect<SagaWorkbenchWorkflow, SagaWorkbenchError>;
    configure: (
      input: SagaWorkbenchConfigureInput,
      actor: Actor,
    ) => Effect.Effect<SagaWorkbenchWorkflow, SagaWorkbenchError>;
    setStage: (
      input: SagaWorkbenchStageInput,
      actor: Actor,
    ) => Effect.Effect<SagaWorkbenchWorkflow, SagaWorkbenchError>;
    approve: (
      input: SagaWorkbenchApproveInput,
      actor: Actor,
    ) => Effect.Effect<SagaWorkbenchWorkflow, SagaWorkbenchError>;
    complete: (
      input: SagaWorkbenchMutationInput,
      actor: Actor,
    ) => Effect.Effect<SagaWorkbenchWorkflow, SagaWorkbenchError>;
    reopen: (
      input: SagaWorkbenchMutationInput,
      actor: Actor,
    ) => Effect.Effect<SagaWorkbenchWorkflow, SagaWorkbenchError>;
    summarize: (
      input: SagaWorkbenchMutationInput,
      actor: Actor,
    ) => Effect.Effect<SagaWorkbenchWorkflow, SagaWorkbenchError>;
  }
>()("t3/stave/SagaWorkbenchService") {}

export const make = Effect.gen(function* () {
  const repo = yield* SagaWorkbenchRepository;
  const reader = yield* StaveWorkspaceReader;
  const projections = yield* ProjectionSnapshotQuery;
  const runtime = yield* StaveRpcRuntime;
  const settings = yield* ServerSettingsService;
  const evidenceReader = yield* SagaWorkbenchEvidence;
  const generator = yield* Effect.serviceOption(TextGeneration);
  const instances = yield* Effect.serviceOption(ProviderInstanceRegistry);
  const lock = yield* StaveSpaceLock;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const summaryLock = yield* Semaphore.make(1);
  const validate = Effect.fn("SagaWorkbench.validate")(function* (
    identity: SagaWorkbenchIdentity,
    allowArchived = false,
  ) {
    if (!config.staveEnabled)
      return yield* fail("Stave integration is disabled by this server.", "unavailable");
    if (!(yield* settings.getSettings).stave.enabled)
      return yield* fail("Enable Stave integration to use the workbench.", "unavailable");
    const project = yield* projections.getProjectShellById(identity.projectId);
    if (Option.isNone(project))
      return yield* fail("The project is no longer available.", "identity");
    const root = yield* fs.realPath(project.value.workspaceRoot);
    if (root !== identity.workspaceRoot)
      return yield* fail("The project workspace has changed.", "identity");
    yield* reader.invalidate(root);
    const info = yield* reader.load(root);
    if (
      Option.isNone(info) ||
      (info.value.state !== "live" && !(allowArchived && info.value.state === "archived")) ||
      info.value.spaceId !== identity.spaceId ||
      info.value.createdAt !== identity.createdAt
    )
      return yield* fail("The space is unavailable or its incarnation has changed.", "identity");
    return { project: project.value, info: info.value };
  }, Effect.mapError(boundary));
  const identityFor = Effect.fn("SagaWorkbench.identityFor")(function* (
    projectId: ProjectId,
    allowArchived = false,
  ) {
    const project = yield* projections.getProjectShellById(projectId);
    if (Option.isNone(project)) return yield* fail("The project is unavailable.", "identity");
    const workspaceRoot = yield* fs.realPath(project.value.workspaceRoot);
    yield* reader.invalidate(workspaceRoot);
    const info = yield* reader.load(workspaceRoot);
    if (Option.isNone(info) || !info.value.createdAt)
      return yield* fail("A verified Stave space is required.", "identity");
    const identity = {
      projectId,
      workspaceRoot,
      spaceId: info.value.spaceId,
      createdAt: info.value.createdAt,
    };
    yield* validate(identity, allowArchived);
    return identity;
  }, Effect.mapError(boundary));
  const archivedWorkflow = Effect.fn("SagaWorkbench.archivedWorkflow")(function* (
    identity: SagaWorkbenchIdentity,
  ) {
    const stored = yield* repo.findIncarnation(identity);
    if (
      !stored ||
      path.basename(path.dirname(identity.workspaceRoot)) !== ".archive" ||
      archiveEntriesMatching(identity.spaceId, [path.basename(identity.workspaceRoot)]).length !== 1
    )
      return null;
    // A copied manifest and rebound project ID do not establish an archive move.
    // Stave archives a space under the same agent-work parent it occupied live.
    const historicalParent = yield* fs
      .realPath(path.dirname(stored.identity.workspaceRoot))
      .pipe(Effect.option);
    const archiveParent = yield* fs
      .realPath(path.dirname(path.dirname(identity.workspaceRoot)))
      .pipe(Effect.option);
    if (
      Option.isNone(historicalParent) ||
      Option.isNone(archiveParent) ||
      historicalParent.value !== archiveParent.value
    )
      return null;
    return { ...stored, evidenceState: "unverified" as const };
  });
  const workflowForDisplay = Effect.fn("SagaWorkbench.workflowForDisplay")(function* (
    identity: SagaWorkbenchIdentity,
  ) {
    const workflow = yield* repo.get(identity);
    if (!workflow.accepted) return workflow;
    const current = yield* evidenceReader
      .revalidate({
        identity,
        allowPullRequestBaseAdvance: true,
        evidence: {
          sourceRevision: workflow.accepted.evidenceRevision,
          manifestRevision: workflow.accepted.manifestRevision,
          observedAt: workflow.accepted.at,
          requirements: workflow.accepted.requirements,
          complete: true,
          blockers: [],
        },
      })
      .pipe(Effect.result);
    return {
      ...workflow,
      evidenceState: current._tag === "Failure" ? ("stale" as const) : ("unverified" as const),
    };
  });
  const getSnapshot: SagaWorkbenchService["Service"]["getSnapshot"] = (input) =>
    Effect.gen(function* () {
      const identity = yield* identityFor(input.projectId, true);
      const { info } = yield* validate(identity, true);
      const workflow =
        info.state === "archived"
          ? yield* archivedWorkflow(identity)
          : yield* workflowForDisplay(identity);
      if (!workflow)
        return yield* fail("Archived workflow history is unavailable or ambiguous.", "unavailable");
      if (!info.isSaga || info.state === "archived") return { identity, workflow, members: [] };
      const status = yield* runtime.sagaStatus(identity.workspaceRoot);
      const shell = yield* projections.getShellSnapshot();
      const members = yield* Effect.forEach(
        status.members,
        (member) =>
          Effect.gen(function* () {
            if (
              !member.workspaceRoot ||
              !member.createdAt ||
              (member.state !== "live" && member.state !== "archived")
            )
              return { ...member, identity: null, workflow: null };
            const projects = shell.projects.filter(
              (project) =>
                project.workspaceRoot === member.workspaceRoot &&
                project.stave?.spaceId === member.id &&
                project.stave?.createdAt === member.createdAt,
            );
            if (projects.length !== 1) return { ...member, identity: null, workflow: null };
            const memberIdentity = {
              projectId: projects[0]!.id,
              workspaceRoot: member.workspaceRoot,
              spaceId: member.id,
              createdAt: member.createdAt,
            };
            const verified = yield* validate(memberIdentity, member.state === "archived").pipe(
              Effect.option,
            );
            if (Option.isNone(verified) || verified.value.info.state !== member.state)
              return { ...member, identity: null, workflow: null };
            return {
              id: member.id,
              after: member.after,
              state: member.state,
              identity: memberIdentity,
              workflow:
                member.state === "archived"
                  ? yield* archivedWorkflow(memberIdentity)
                  : yield* workflowForDisplay(memberIdentity),
            };
          }),
        { concurrency: 4 },
      );
      return { identity, workflow, members };
    }).pipe(Effect.mapError(boundary));
  const getEvidence: SagaWorkbenchService["Service"]["getEvidence"] = (input) =>
    Effect.gen(function* () {
      yield* validate(input.identity);
      const workflow = yield* repo.get(input.identity);
      return yield* evidenceReader.read({
        ...input,
        ...(workflow.accepted ? { acceptedRequirements: workflow.accepted.requirements } : {}),
      });
    }).pipe(Effect.mapError(boundary));
  const getActivity: SagaWorkbenchService["Service"]["getActivity"] = (input) =>
    Effect.gen(function* () {
      const { info } = yield* validate(input.identity, true);
      if (info.state !== "archived") return yield* repo.activity(input.identity);
      const workflow = yield* archivedWorkflow(input.identity);
      return workflow ? yield* repo.activity(workflow.identity) : [];
    });
  // A board member must still appear in a live, verified saga roster. Stave
  // projects outside a saga do not acquire automatic background model calls.
  const verifyBoardIdentity = Effect.fn("SagaWorkbench.verifyBoardIdentity")(function* (
    identity: SagaWorkbenchIdentity,
  ) {
    const { info } = yield* validate(identity);
    if (info.isSaga) return;
    const shell = yield* projections.getShellSnapshot();
    for (const project of shell.projects.filter((project) => project.stave?.isSaga)) {
      const sagaIdentity = yield* identityFor(project.id).pipe(Effect.option);
      if (Option.isNone(sagaIdentity)) continue;
      const status = yield* runtime
        .sagaStatus(sagaIdentity.value.workspaceRoot)
        .pipe(Effect.option);
      if (Option.isNone(status)) continue;
      if (
        status.value.sagaId !== sagaIdentity.value.spaceId ||
        status.value.sagaCreatedAt !== sagaIdentity.value.createdAt
      )
        continue;
      if (
        status.value.members.some(
          (member) =>
            member.state === "live" &&
            member.workspaceRoot === identity.workspaceRoot &&
            member.id === identity.spaceId &&
            member.createdAt === identity.createdAt,
        )
      )
        return;
    }
    return yield* fail("This space is not a current member of a saga board.", "unavailable");
  }, Effect.mapError(boundary));

  const preparePromptInference = Effect.fn("SagaWorkbench.preparePromptInference")(function* (
    event: PromptInferenceEvent,
  ) {
    if (!config.staveEnabled || !(yield* settings.getSettings).stave.enabled) return null;
    const thread = yield* projections.getThreadShellById(event.payload.threadId);
    if (Option.isNone(thread) || thread.value.archivedAt) return null;
    const identity = yield* identityFor(thread.value.projectId).pipe(Effect.option);
    if (Option.isNone(identity)) return null;
    const member = yield* verifyBoardIdentity(identity.value).pipe(Effect.option);
    if (Option.isNone(member)) return null;
    const turns = yield* projections.getInferenceTurnPairs({
      threadId: thread.value.id,
      beforeMessageId: event.payload.messageId,
    });
    if (turns.length === 0) return null;
    return {
      identity: identity.value,
      threadId: thread.value.id,
      beforeMessageId: event.payload.messageId,
      modelSelection: event.payload.modelSelection ?? thread.value.modelSelection,
      turns,
      eventId: event.eventId,
      sequence: event.sequence,
    };
  }, Effect.mapError(boundary));

  const infer = Effect.fn("SagaWorkbench.infer")(function* (
    input: SagaWorkbenchMutationInput,
    actor: Actor,
    submitted?: SagaInferenceRequest,
  ) {
    if (!actor.scopes.includes(AuthOrchestrationOperateScope))
      return yield* fail("This session is not authorized to change workflows.", "blocked");
    yield* validate(input.identity);
    const receiptKey = {
      identity: input.identity,
      actorKey: fingerprint([actor.subject, actor.sessionId]),
      requestId: input.requestId,
      requestHash: fingerprint(
        submitted ? { action: "infer", submitted } : { action: "summarize", input },
      ),
    };
    const receipt = yield* repo.receipt(receiptKey);
    if (receipt) return receipt;
    const current = yield* repo.get(input.identity);
    if (submitted && (current.lastInferenceSequence ?? -1) >= submitted.sequence) return current;
    if (!submitted && current.revision !== input.expectedRevision)
      return yield* fail("Workflow changed. Refresh before trying again.", "conflict");
    if (submitted) yield* verifyBoardIdentity(input.identity);
    let source = submitted;
    if (!source) {
      const shell = yield* projections.getShellSnapshot();
      const threads = shell.threads
        .filter((thread) => thread.projectId === input.identity.projectId && !thread.archivedAt)
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      for (const thread of threads) {
        const turns = yield* projections.getInferenceTurnPairs({ threadId: thread.id });
        if (!turns.length) continue;
        source = {
          identity: input.identity,
          threadId: thread.id,
          modelSelection: thread.modelSelection,
          turns,
          eventId: input.requestId,
          sequence: 0,
        };
        break;
      }
    }
    if (!source)
      return yield* fail(
        "A completed question and response are needed before generating a summary.",
        "generation",
      );
    if (Option.isNone(generator) || Option.isNone(instances))
      return yield* fail("Summary generation is unavailable in this environment.", "generation");
    const instance = yield* instances.value.getInstance(source.modelSelection.instanceId);
    if (!instance?.enabled)
      return yield* fail("The conversation's provider account is unavailable.", "generation");
    const catalog = yield* instance.snapshot.getSnapshot;
    const modelSelection = resolveSagaInferenceModel(
      source.modelSelection,
      instance.driverKind,
      catalog.models,
    );
    const message = yield* encodeInput({
      priorSummary: current.summary?.text ?? null,
      turns: source.turns,
    });
    const sourceRevision = fingerprint({ message, modelSelection, promptVersion: 3 });
    const generated = yield* generator.value
      .generateWorkflowSummary({
        cwd: input.identity.workspaceRoot,
        message,
        modelSelection,
      })
      .pipe(
        Effect.flatMap(decodeInference),
        Effect.mapError(() =>
          fail(
            "Summary generation failed. The previous summary and stage were preserved.",
            "generation",
          ),
        ),
      );
    const latestThread = yield* projections.getThreadShellById(source.threadId);
    const latestTurns = yield* projections.getInferenceTurnPairs({
      threadId: source.threadId,
      ...(source.beforeMessageId ? { beforeMessageId: source.beforeMessageId } : {}),
    });
    if (
      Option.isNone(latestThread) ||
      latestThread.value.projectId !== input.identity.projectId ||
      latestThread.value.archivedAt ||
      fingerprint(latestTurns) !== fingerprint(source.turns)
    )
      return yield* fail("The conversation changed during generation. Refresh again.", "conflict");
    if (submitted) yield* verifyBoardIdentity(input.identity);
    return yield* lock.withSpaceLock(
      input.identity.workspaceRoot,
      Effect.gen(function* () {
        yield* validate(input.identity);
        // Roster checks do not run under the lifecycle lock. The physical space
        // incarnation is fenced here; membership was checked again after generation.
        const latest = yield* repo.get(input.identity);
        if (submitted && (latest.lastInferenceSequence ?? -1) >= submitted.sequence) return latest;
        if (latest.summary?.sourceRevision !== current.summary?.sourceRevision)
          return yield* fail(
            "The prior summary changed during generation. Refresh again.",
            "conflict",
          );
        const canMove =
          latest.revision === current.revision &&
          latest.automaticStage !== false &&
          !latest.stagePinned &&
          !latest.completedAt;
        const stage = canMove ? generated.stage : latest.stage;
        const updated: SagaWorkbenchWorkflow = {
          ...latest,
          revision: latest.revision + 1,
          stage,
          accepted: stage !== latest.stage ? null : latest.accepted,
          ...(submitted ? { lastInferenceSequence: submitted.sequence } : {}),
          summary: {
            text: generated.summary,
            inferredStage: generated.stage,
            confidence: generated.confidence,
            sourceRevision,
            generatedAt: yield* now,
            sources: [{ label: "Conversation", url: `lecturn:thread:${source.threadId}` }],
          },
        };
        return yield* repo.save({
          ...receiptKey,
          expectedRevision: latest.revision,
          workflow: updated,
          activity: {
            revision: updated.revision,
            at: updated.summary!.generatedAt,
            action: "summarize",
            subject: actor.subject,
            sessionId: actor.sessionId,
            detail:
              stage !== latest.stage
                ? `Updated the summary and inferred ${stage} stage.`
                : "Updated the conversation summary; the workflow stage was preserved.",
          },
        });
      }),
    );
  }, Effect.mapError(boundary));

  type Mutation = SagaWorkbenchMutationInput & {
    stage?: SagaWorkbenchStageInput["stage"];
    expectedEvidenceRevision?: string;
    automaticStage?: boolean;
    stagePinned?: boolean;
  };
  const mutate = Effect.fn("SagaWorkbench.mutate")(function* (
    action: "stage" | "approve" | "complete" | "reopen" | "configure",
    input: Mutation,
    actor: Actor,
  ) {
    if (!actor.scopes.includes(AuthOrchestrationOperateScope))
      return yield* fail("This session is not authorized to change workflows.", "blocked");
    yield* validate(input.identity);
    const receiptKey = {
      identity: input.identity,
      actorKey: fingerprint([actor.subject, actor.sessionId]),
      requestId: input.requestId,
      requestHash: fingerprint({ action, input }),
    };
    const prior = yield* repo.receipt(receiptKey);
    if (prior) return prior;
    const current = yield* repo.get(input.identity);
    if (current.revision !== input.expectedRevision)
      return yield* fail("Workflow changed. Refresh before trying again.", "conflict");
    let evidence: Evidence | undefined;
    if (
      action === "stage" &&
      (current.automaticStage !== false || current.stagePinned || current.completedAt)
    )
      return yield* fail(
        current.stagePinned
          ? "Unpin the stage before moving this space."
          : current.completedAt
            ? "Reopen completed work before changing its stage."
            : "Disable automatic stages before moving this space manually.",
      );
    if (action === "approve" || action === "complete") {
      evidence = yield* evidenceReader.read({
        identity: input.identity,
        ...(action === "complete" && current.accepted
          ? { acceptedRequirements: current.accepted.requirements }
          : {}),
      });
      if (action === "approve") {
        if (current.stage !== "accept")
          return yield* fail("Move this space to Accept before approving it.");
        if (input.expectedEvidenceRevision !== evidence.sourceRevision)
          return yield* fail(
            "Evidence changed. Refresh and review the current revisions.",
            "conflict",
          );
        yield* refuseBlockers(approvalBlockers(evidence));
      }
      if (action === "complete") {
        if (current.stage !== "accept") return yield* fail("Only accepted work can be completed.");
        yield* refuseBlockers(completionBlockers(evidence, current.accepted));
      }
    }
    return yield* lock.withSpaceLock(
      input.identity.workspaceRoot,
      Effect.gen(function* () {
        yield* validate(input.identity);
        if (evidence) yield* evidenceReader.revalidate({ identity: input.identity, evidence });
        const at = yield* now;
        const workflow: SagaWorkbenchWorkflow = { ...current, revision: current.revision + 1 };
        const updated =
          action === "stage"
            ? {
                ...workflow,
                stage: input.stage!,
                accepted: input.stage === "accept" ? current.accepted : null,
                completedAt: null,
              }
            : action === "reopen"
              ? { ...workflow, accepted: null, completedAt: null }
              : action === "approve"
                ? {
                    ...workflow,
                    accepted: {
                      at,
                      subject: actor.subject,
                      sessionId: actor.sessionId,
                      evidenceRevision: evidence!.sourceRevision,
                      manifestRevision: evidence!.manifestRevision,
                      requirements: evidence!.requirements,
                    },
                    completedAt: null,
                  }
                : action === "complete"
                  ? { ...workflow, completedAt: at }
                  : {
                      ...workflow,
                      ...(input.automaticStage !== undefined
                        ? { automaticStage: input.automaticStage }
                        : {}),
                      ...(input.stagePinned !== undefined
                        ? { stagePinned: input.stagePinned }
                        : {}),
                    };
        return yield* repo.save({
          ...receiptKey,
          expectedRevision: input.expectedRevision,
          workflow: updated,
          activity: {
            revision: updated.revision,
            at,
            action,
            subject: actor.subject,
            sessionId: actor.sessionId,
            detail:
              action === "stage"
                ? `Stage changed to ${input.stage}.`
                : action === "approve"
                  ? "Accepted the recorded repository revisions."
                  : action === "complete"
                    ? "Verified acceptance, required CI and merge for every repository."
                    : action === "reopen"
                      ? "Reopened work; current acceptance cleared."
                      : "Updated automatic stage and pin settings.",
          },
        });
      }),
    );
  }, Effect.mapError(boundary));
  const inferenceFailureKey = (input: SagaInferenceRequest) => ({
    identity: input.identity,
    actorKey: fingerprint([inferenceActor.subject, inferenceActor.sessionId]),
    requestId: `failure:prompt:${input.eventId}`,
    requestHash: fingerprint({ action: "inference-failed", input }),
  });
  const recordInferenceFailure = Effect.fn("SagaWorkbench.recordInferenceFailure")(function* (
    input: SagaInferenceRequest,
    error: SagaWorkbenchError,
  ) {
    return yield* lock.withSpaceLock(
      input.identity.workspaceRoot,
      Effect.gen(function* () {
        yield* validate(input.identity);
        const key = inferenceFailureKey(input);
        if (yield* repo.receipt(key)) return;
        const latest = yield* repo.get(input.identity);
        if ((latest.lastInferenceSequence ?? -1) >= input.sequence) return;
        const workflow = { ...latest, revision: latest.revision + 1 };
        yield* repo.save({
          ...key,
          expectedRevision: latest.revision,
          workflow,
          activity: {
            revision: workflow.revision,
            at: yield* now,
            action: "inference-failed",
            subject: inferenceActor.subject,
            sessionId: inferenceActor.sessionId,
            detail:
              error.code === "generation"
                ? "Summary and stage update failed. Check the conversation's provider account, then refresh the summary."
                : "Summary and stage update was skipped because the workspace or workflow changed. Refresh to try again.",
          },
        });
      }),
    );
  }, Effect.mapError(boundary));
  const inferFromPrompt = (submitted: SagaInferenceRequest) =>
    summaryLock.withPermits(1)(
      Effect.gen(function* () {
        if (yield* repo.receipt(inferenceFailureKey(submitted)))
          return yield* fail(
            "This prompt's summary update failed. Refresh the summary to retry.",
            "generation",
          );
        return yield* infer(
          {
            identity: submitted.identity,
            expectedRevision: 0,
            requestId: `prompt:${submitted.eventId}`,
          },
          inferenceActor,
          submitted,
        ).pipe(
          Effect.catch((error) =>
            recordInferenceFailure(submitted, error).pipe(
              Effect.ignore,
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
      }),
    );
  return SagaWorkbenchService.of({
    getSnapshot,
    getEvidence,
    getActivity,
    preparePromptInference,
    inferFromPrompt,
    configure: (input, actor) => mutate("configure", input, actor),
    setStage: (input, actor) => mutate("stage", input, actor),
    approve: (input, actor) => mutate("approve", input, actor),
    complete: (input, actor) => mutate("complete", input, actor),
    reopen: (input, actor) => mutate("reopen", input, actor),
    summarize: (input, actor) => summaryLock.withPermits(1)(infer(input, actor)),
  });
});
export const layer = Layer.effect(SagaWorkbenchService, make);
