import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  ChatAttachment,
  ModelSelection,
  ProviderInstanceId,
  SagaWorkbenchInferenceResult,
  DecisionWriterInput,
  DecisionWriterOutput,
} from "@lecturn/contracts";
import { TextGenerationError } from "@lecturn/contracts";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

export type TextGenerationProvider = "codex" | "claudeAgent" | "cursor" | "grok" | "opencode";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface WorkflowSummaryGenerationInput {
  cwd: string;
  message: string;
  modelSelection: ModelSelection;
}

export type WorkflowSummaryGenerationResult = SagaWorkbenchInferenceResult;

export type DecisionNotesGenerationInput = DecisionWriterInput & {
  readonly cwd: string;
  readonly repairFeedback?: string;
};
export interface DecisionWriterCheckInput {
  readonly cwd: string;
  readonly modelSelection: ModelSelection;
}
export interface DecisionWriterCapability {
  readonly supported: boolean;
  readonly reason: string | null;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    /** Optional: absence means the provider cannot guarantee isolated background writing. */
    readonly generateDecisionNotes?: (
      input: DecisionNotesGenerationInput,
    ) => Effect.Effect<DecisionWriterOutput, TextGenerationError>;
    /** Read-only preflight before paid detection and again before writer dispatch. */
    readonly checkDecisionWriter?: (
      input: DecisionWriterCheckInput,
    ) => Effect.Effect<DecisionWriterCapability, TextGenerationError>;
    /**
     * Generate a commit message from staged change context.
     */
    readonly generateCommitMessage: (
      input: CommitMessageGenerationInput,
    ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

    /**
     * Generate change request title/body from branch and diff context.
     */
    readonly generatePrContent: (
      input: PrContentGenerationInput,
    ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

    /**
     * Generate a concise branch name from a user message.
     */
    readonly generateBranchName: (
      input: BranchNameGenerationInput,
    ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

    /** Explain supplied workflow evidence without changing workflow facts. */
    readonly generateWorkflowSummary: (
      input: WorkflowSummaryGenerationInput,
    ) => Effect.Effect<WorkflowSummaryGenerationResult, TextGenerationError>;

    /** Generate a concise thread title from a first message or thread history. */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;
  }
>()("lecturn/textGeneration/TextGeneration") {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateWorkflowSummary"
  | "generateDecisionNotes"
  | "checkDecisionWriter";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance?.enabled
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No enabled provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

export type RoutedTextGeneration = TextGeneration["Service"] &
  Required<Pick<TextGeneration["Service"], "checkDecisionWriter" | "generateDecisionNotes">>;

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
): RoutedTextGeneration => ({
  checkDecisionWriter: (input) =>
    resolveInstance(registry, "checkDecisionWriter", input.modelSelection.instanceId).pipe(
      Effect.flatMap(
        (textGeneration) =>
          textGeneration.checkDecisionWriter?.(input) ??
          Effect.succeed({
            supported: false,
            reason: "This provider does not support isolated Decisions writing.",
          }),
      ),
    ),
  generateDecisionNotes: (input) =>
    resolveInstance(registry, "generateDecisionNotes", input.modelSelection.instanceId).pipe(
      Effect.flatMap(
        (textGeneration) =>
          textGeneration.generateDecisionNotes?.(input) ??
          Effect.fail(
            new TextGenerationError({
              operation: "generateDecisionNotes",
              detail: "This provider does not support isolated Decisions writing.",
            }),
          ),
      ),
    ),
  generateCommitMessage: (input) =>
    resolveInstance(registry, "generateCommitMessage", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)),
    ),
  generatePrContent: (input) =>
    resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
    ),
  generateBranchName: (input) =>
    resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
    ),
  generateWorkflowSummary: (input) =>
    resolveInstance(registry, "generateWorkflowSummary", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generateWorkflowSummary(input)),
    ),
  generateThreadTitle: (input) =>
    resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generateThreadTitle(input)),
    ),
});

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return makeTextGenerationFromRegistry(registry);
});

export const layer = Layer.effect(TextGeneration, make);
