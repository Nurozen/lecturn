/**
 * The intent stores the whole launch input with deterministic ids, so a crash between `thread.create` and the initial
 * message reconciles from the two receipts, never a second thread. Created threads are ordinary (unmarked).
 * @module squire/SquireLaunchAction
 */
import {
  CommandId,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  type SquireCardPayload,
  ThreadId,
  TrimmedNonEmptyString,
  DEFAULT_PROVIDER_INTERACTION_MODE,
} from "@lecturn/contracts";
import { resolveProjectSettings } from "@lecturn/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { type SquireActionVerb, squireActionCommandId } from "./squireActionIntent.ts";
import type { SquireCardRow, SquireRow } from "./SquireRepository.ts";
import { isFixtureWorkspaceRoot } from "./SquireReactor.ts";

export const SquireLaunchIntent = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  // Proposals name no branch or worktree; a wider strategy is an additive member.
  workspaceStrategy: Schema.Struct({ type: Schema.Literal("root") }),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
  threadId: ThreadId,
  commandId: CommandId,
  messageId: MessageId,
  /** `user` for an accept, `agent` for a held execution. */
  createdBy: Schema.Literals(["user", "agent"]),
  senderThreadId: Schema.optionalKey(ThreadId),
});
export type SquireLaunchIntent = typeof SquireLaunchIntent.Type;

export type SquireThreadProposal = Extract<SquireCardPayload, { readonly type: "thread-proposal" }>;

/** A refusal `launch` reports before or instead of committing: the card reopens uncharged. */
export class SquireLaunchRefused extends Schema.TaggedError<SquireLaunchRefused>()(
  "SquireLaunchRefused",
  { reason: Schema.String },
) {}

/** Any other launch failure: the outcome is unknown until the receipts say otherwise. */
export class SquireLaunchFailed extends Schema.TaggedError<SquireLaunchFailed>()(
  "SquireLaunchFailed",
  { commandId: CommandId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Squire thread launch ${this.commandId} ended with an unknown outcome.`;
  }
}

export type SquireReceiptState =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "absent" };

export interface SquireLaunchReceipts {
  readonly create: SquireReceiptState;
  readonly message: SquireReceiptState;
}

/** The id ThreadLaunchService gives the initial message's `message.dispatch`. */
const initialMessageCommandId = (commandId: CommandId) =>
  CommandId.make(`${commandId}:initial-message`);

export interface SquireLaunchIntentInput {
  readonly card: Pick<SquireCardRow, "id">;
  readonly proposal: SquireThreadProposal;
  /** The user's final text on accept; the proposal's first prompt for a hold. */
  readonly text: string;
  readonly verb: SquireActionVerb;
  readonly attempt: number;
  /** The Squire's home thread, attributed on a held execution. */
  readonly senderThreadId: ThreadId | null;
  readonly modes: {
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  };
  /**
   * The scripted instance's selection when the proposing Squire or its
   * project is a fixture's; the thread then runs on it whatever was proposed.
   */
  readonly fixtureOwned: ModelSelection | null;
}

const firstLine = (value: string) => value.split("\n")[0]!.trim().slice(0, 120).trim();

/** Pure: the same card, attempt, and text always give the same ids. */
export const launchIntentFor = (
  input: SquireLaunchIntentInput,
): Result.Result<SquireLaunchIntent, SquireLaunchRefused> => {
  const text = input.text.trim();
  if (text.length === 0) {
    return Result.fail(new SquireLaunchRefused({ reason: "The first prompt is empty." }));
  }
  const modelSelection: ModelSelection | null =
    input.fixtureOwned ??
    (input.proposal.providerInstanceId === null || input.proposal.model === null
      ? null
      : { instanceId: input.proposal.providerInstanceId, model: input.proposal.model });
  if (modelSelection === null) {
    return Result.fail(
      new SquireLaunchRefused({
        reason: `No enabled ${input.proposal.provider} provider is available.`,
      }),
    );
  }
  const key = `${input.card.id}:${input.attempt}`;
  const agent = input.verb === "execute";
  return Result.succeed({
    projectId: input.proposal.projectId,
    title: TrimmedNonEmptyString.make(firstLine(text) || "New thread"),
    modelSelection,
    runtimeMode: input.modes.runtimeMode,
    interactionMode: input.modes.interactionMode,
    workspaceStrategy: { type: "root" },
    text: TrimmedNonEmptyString.make(text.slice(0, 8000).trim()),
    threadId: ThreadId.make(`thread:squire-create:${key}`),
    commandId: CommandId.make(squireActionCommandId(input.verb, input.card.id, input.attempt)),
    messageId: MessageId.make(`message:squire-create:${key}`),
    createdBy: agent ? "agent" : "user",
    ...(agent && input.senderThreadId !== null ? { senderThreadId: input.senderThreadId } : {}),
  });
};

export interface SquireLaunchPrepareInput {
  readonly card: Pick<SquireCardRow, "id">;
  readonly squire: Pick<SquireRow, "create_request_id" | "home_thread_id">;
  readonly proposal: SquireThreadProposal;
  readonly text: string;
  readonly verb: SquireActionVerb;
  readonly attempt: number;
}

export class SquireLaunchAction extends Context.Service<
  SquireLaunchAction,
  {
    /** `launchIntentFor` with the project's default modes and the fixture runner resolved. */
    readonly intentFor: (
      input: SquireLaunchPrepareInput,
    ) => Effect.Effect<SquireLaunchIntent, SquireLaunchRefused | SquireLaunchFailed>;
    readonly receipts: (
      intent: SquireLaunchIntent,
    ) => Effect.Effect<SquireLaunchReceipts, SquireLaunchFailed>;
    /** Never `reuseExistingThread`: a committed create replays from its receipt. */
    readonly launch: (
      intent: SquireLaunchIntent,
    ) => Effect.Effect<void, SquireLaunchRefused | SquireLaunchFailed>;
    /** Archives the intent's thread when its create committed and it holds no message. */
    readonly archiveEmpty: (intent: SquireLaunchIntent) => Effect.Effect<void>;
  }
>()("lecturn/squire/SquireLaunchAction") {}

const causeTag = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "_tag" in cause ? String(cause._tag) : undefined;

const causeMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

// Rejections the orchestrator or ThreadLaunchService report on purpose; a
// failed read or a lost connection leaves the outcome to the receipts.
const REFUSAL_TAGS: ReadonlySet<string> = new Set([
  "ThreadManagementProviderInstanceDisabledError",
  "OrchestratorCommandRejectedError",
  "OrchestratorCommandPreviouslyRejectedError",
  // The clone tracker's refusal while a clone runs or after it failed.
  "OrchestrationDispatchCommandError",
]);

const refusalOf = (
  error:
    | ThreadLaunch.ThreadLaunchError
    | ThreadManagement.ThreadManagementProviderInstanceDisabledError,
): string | undefined => {
  if (error._tag === "ThreadManagementProviderInstanceDisabledError") return error.message;
  const tag = causeTag(error.cause);
  if (tag !== undefined && REFUSAL_TAGS.has(tag)) return causeMessage(error.cause);
  // "Project not found." and "Project identity changed." are plain strings.
  if (error.operation === "resolve-project" && typeof error.cause === "string") return error.cause;
  return undefined;
};

const receiptState = (
  receipt: Option.Option<CommandReceiptStore.CommandReceiptV2>,
): SquireReceiptState =>
  Option.match(receipt, {
    onNone: () => ({ status: "absent" }),
    onSome: (found) =>
      found.status === "accepted"
        ? { status: "accepted" }
        : { status: "rejected", reason: found.error ?? "The command was rejected." },
  });

const make = Effect.gen(function* () {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const receiptStore = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const config = yield* ServerConfig.ServerConfig;

  const failed = (commandId: CommandId) => (cause: unknown) =>
    new SquireLaunchFailed({ commandId, cause });

  const scriptedModel = Effect.gen(function* () {
    const instance = (yield* providers.listInstances).find(
      (candidate) => candidate.enabled && String(candidate.driverKind) === "scripted",
    );
    if (instance === undefined) {
      return yield* new SquireLaunchRefused({
        reason: "No scripted provider instance is available for this fixture.",
      });
    }
    const models = (yield* instance.snapshot.getSnapshot).models;
    const model = models.find((candidate) => candidate.isDefault) ?? models[0];
    if (model === undefined) {
      return yield* new SquireLaunchRefused({ reason: "The scripted provider lists no model." });
    }
    return { instanceId: instance.instanceId, model: model.slug } satisfies ModelSelection;
  });

  const intentFor: SquireLaunchAction["Service"]["intentFor"] = Effect.fn(
    "SquireLaunchAction.intentFor",
  )(function* (input) {
    const commandId = CommandId.make(
      squireActionCommandId(input.verb, input.card.id, input.attempt),
    );
    const project = yield* projects
      .get(input.proposal.projectId)
      .pipe(Effect.mapError(failed(commandId)));
    if (Option.isNone(project)) {
      return yield* new SquireLaunchRefused({ reason: "The project no longer exists." });
    }
    const fixture =
      (input.squire.create_request_id?.startsWith("fixture:") ?? false) ||
      isFixtureWorkspaceRoot(config.baseDir, project.value.workspaceRoot);
    const current = yield* settings.getSettings.pipe(Effect.mapError(failed(commandId)));
    const fixtureOwned = fixture ? yield* scriptedModel : null;
    return yield* Effect.fromResult(
      launchIntentFor({
        card: input.card,
        proposal: input.proposal,
        text: input.text,
        verb: input.verb,
        attempt: input.attempt,
        senderThreadId: input.squire.home_thread_id,
        modes: {
          runtimeMode: resolveProjectSettings(current, input.proposal.projectId).settings
            .defaultRuntimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        },
        fixtureOwned,
      }),
    );
  });

  const receipts: SquireLaunchAction["Service"]["receipts"] = (intent) =>
    Effect.all({
      create: receiptStore.getByCommandId(intent.commandId).pipe(Effect.map(receiptState)),
      message: receiptStore
        .getByCommandId(initialMessageCommandId(intent.commandId))
        .pipe(Effect.map(receiptState)),
    }).pipe(Effect.mapError(failed(intent.commandId)));

  const launch: SquireLaunchAction["Service"]["launch"] = (intent) =>
    launches
      .launch({
        commandId: intent.commandId,
        threadId: intent.threadId,
        projectId: intent.projectId,
        title: intent.title,
        modelSelection: intent.modelSelection,
        runtimeMode: intent.runtimeMode,
        interactionMode: intent.interactionMode,
        workspaceStrategy: intent.workspaceStrategy,
        initialMessage: {
          messageId: intent.messageId,
          text: intent.text,
          attachments: [],
          ...(intent.senderThreadId === undefined ? {} : { senderThreadId: intent.senderThreadId }),
        },
        createdBy: intent.createdBy,
        creationSource: "server",
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError((error) => {
          const reason = refusalOf(error);
          return reason === undefined
            ? failed(intent.commandId)(error)
            : new SquireLaunchRefused({ reason });
        }),
      );

  const archiveEmpty: SquireLaunchAction["Service"]["archiveEmpty"] = Effect.fn(
    "SquireLaunchAction.archiveEmpty",
  )(
    function* (intent) {
      const shell = yield* threads.getThreadShell(intent.threadId);
      if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) return;
      if ((yield* threads.getMessageCount(intent.threadId)) > 0) return;
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`${intent.commandId}:archive`),
        threadId: intent.threadId,
      });
    },
    (effect, intent) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Squire could not archive an empty launched thread", {
            threadId: intent.threadId,
            cause,
          }),
        ),
      ),
  );

  return SquireLaunchAction.of({ intentFor, receipts, launch, archiveEmpty });
});

export const layer = Layer.effect(SquireLaunchAction, make);
