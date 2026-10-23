import type {
  BranchNamingOptions,
  ChatAttachment,
  DecisionWriterInput,
  DecisionWriterOutputAny,
  ModelSelection,
  SagaWorkbenchInferenceResult,
  PullRequestReviewGuide,
  TextGenerationError,
} from "@lecturn/contracts";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
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
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
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

export interface ReviewGuideStackLayer {
  readonly number: number;
  readonly title: string | null;
  readonly headSha: string | null;
  readonly state: "open" | "closed" | "merged";
}

export interface ReviewGuideGenerationInput {
  cwd: string;
  number: number;
  title: string;
  description: string;
  baseBranch: string;
  baseCommit: string;
  settledReview: string;
  instructions?: string | undefined;
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  modelSelection: ModelSelection;
}

export type ReviewGuideGenerationResult = Omit<
  PullRequestReviewGuide,
  "headSha" | "generatedAt" | "modelSelection"
>;

/**
 * Commit, change request, branch, title, summary, and review guide generation backed by one
 * provider instance.
 */
export interface ProviderTextGeneration {
  /** Optional: absence means the provider cannot guarantee isolated background writing. */
  readonly generateDecisionNotes?: (
    input: DecisionNotesGenerationInput,
  ) => Effect.Effect<DecisionWriterOutputAny, TextGenerationError>;

  /** Read-only preflight before paid detection and again before writer dispatch. */
  readonly checkDecisionWriter?: (
    input: DecisionWriterCheckInput,
  ) => Effect.Effect<DecisionWriterCapability, TextGenerationError>;

  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

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

  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  readonly generateReviewGuide: (
    input: ReviewGuideGenerationInput,
  ) => Effect.Effect<ReviewGuideGenerationResult, TextGenerationError>;
}
