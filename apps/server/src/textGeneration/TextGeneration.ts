import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProviderInstanceId } from "@lecturn/contracts";
import type { ProviderTextGeneration } from "@lecturn/provider-core/server/textGeneration";
import { TextGenerationError } from "@lecturn/contracts";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  ContextualSummaryGenerationInput,
  DecisionNotesGenerationInput,
  DecisionWriterCapability,
  DecisionWriterCheckInput,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
  WorkflowSummaryGenerationInput,
  WorkflowSummaryGenerationResult,
} from "@lecturn/provider-core/server/textGeneration";

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "lecturn/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateWorkflowSummary"
  | "generateContextualSummary"
  | "generateDecisionNotes"
  | "checkDecisionWriter"
  | "generateReviewGuide";

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
  Required<
    Pick<
      TextGeneration["Service"],
      "checkDecisionWriter" | "generateDecisionNotes" | "generateContextualSummary"
    >
  >;

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  sourceControl: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"],
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
  generateContextualSummary: (input) =>
    resolveInstance(registry, "generateContextualSummary", input.modelSelection.instanceId).pipe(
      Effect.flatMap(
        (generation) =>
          generation.generateContextualSummary?.(input) ??
          Effect.fail(
            new TextGenerationError({
              operation: "generateContextualSummary",
              detail: "This provider does not support isolated Contextual summaries.",
            }),
          ),
      ),
    ),
  generateWorkflowSummary: (input) =>
    resolveInstance(registry, "generateWorkflowSummary", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generateWorkflowSummary(input)),
    ),
  generateReviewGuide: (input) =>
    resolveInstance(registry, "generateReviewGuide", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generateReviewGuide(input)),
    ),
  generateThreadTitle: (input) =>
    resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) =>
        Effect.gen(function* () {
          const linkedContext =
            input.linkedContext ??
            (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
              Effect.provideService(
                SourceControlProviderRegistry.SourceControlProviderRegistry,
                sourceControl,
              ),
            ));
          return yield* textGeneration.generateThreadTitle({ ...input, linkedContext });
        }),
      ),
    ),
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  return makeTextGenerationFromRegistry(registry, sourceControl);
});

export const layer = Layer.effect(TextGeneration, make);
