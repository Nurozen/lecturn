import type {
  BranchNamingOptions,
  ChatAttachment,
  DecisionWriterInput,
  DecisionWriterOutputAny,
  ModelSelection,
  SagaWorkbenchInferenceResult,
  TextGenerationError,
} from "@lecturn/contracts";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";

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
  naming?: BranchNamingOptions | undefined;
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
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

export interface ContextualSummaryGenerationInput {
  cwd: string;
  message: string;
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

/** Commit, change request, branch, title, and summary generation backed by one provider instance. */
export interface ProviderTextGeneration {
  /** Optional: absence means the provider cannot guarantee isolated background writing. */
  readonly generateDecisionNotes?: (
    input: DecisionNotesGenerationInput,
  ) => Effect.Effect<DecisionWriterOutputAny, TextGenerationError>;

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

  /** Optional: only providers that guarantee isolated, tool-free generation support this. */
  readonly generateContextualSummary?: (
    input: ContextualSummaryGenerationInput,
  ) => Effect.Effect<{ text: string }, TextGenerationError>;

  /** Explain supplied workflow evidence without changing workflow facts. */
  readonly generateWorkflowSummary: (
    input: WorkflowSummaryGenerationInput,
  ) => Effect.Effect<WorkflowSummaryGenerationResult, TextGenerationError>;

  /** Generate a concise thread title from a first message or thread history. */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;
}
