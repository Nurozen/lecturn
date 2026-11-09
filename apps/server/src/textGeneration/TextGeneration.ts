import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ModelSelection, ProviderInstanceId } from "@lecturn/contracts";
import {
  isProviderAvailable,
  isProviderTextGenerationCapable,
  resolveProjectProviderInstanceEnabled,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import { exhaustedUsageWindow } from "@lecturn/shared/usageLimits";
import {
  defaultTextGenerationModel,
  fallbackTextGenerationModelSelection,
} from "@lecturn/shared/serverSettings";
import * as ServerSettings from "../serverSettings.ts";
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
  SquireTurnSummaryGenerationInput,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
  WorkflowSummaryGenerationInput,
  WorkflowSummaryGenerationResult,
} from "@lecturn/provider-core/server/textGeneration";

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
  | "generateSquireTurnSummary"
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
      | "checkDecisionWriter"
      | "generateDecisionNotes"
      | "generateContextualSummary"
      | "generateSquireTurnSummary"
    >
  >;

// Review guides investigate the checkout read-only; the other drivers reject that request.
const INVESTIGATING_DRIVERS = new Set(["codex", "claudeAgent"]);

/** Without `serverSettings` an exhausted provider is used as selected, with no fallback. */
export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  sourceControl: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"],
  serverSettings?: ServerSettings.ServerSettingsService["Service"],
): RoutedTextGeneration => {
  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
    operation: TextGenerationOp,
    selection: ModelSelection,
    invoke: (
      service: ProviderTextGeneration,
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    if (serverSettings !== undefined) {
      const snapshots = yield* registry.listInstances.pipe(
        Effect.flatMap((instances) =>
          Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot),
        ),
      );
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const limited = exhaustedUsageWindow(
        snapshots.find((provider) => provider.instanceId === selection.instanceId),
        now,
        selection.model,
      );
      if (limited) {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Could not read fallback model settings.",
                cause,
              }),
          ),
        );
        selection =
          fallbackTextGenerationModelSelection(
            settings.providerInstances,
            (instanceId, driver) => {
              const provider = snapshots.find((candidate) => candidate.instanceId === instanceId);
              return (
                instanceId !== selection.instanceId &&
                provider?.enabled === true &&
                resolveProjectProviderInstanceEnabled(settings, null, instanceId) &&
                provider.installed &&
                provider.auth.status !== "unauthenticated" &&
                isProviderAvailable(provider) &&
                isProviderTextGenerationCapable(provider) &&
                (operation !== "generateReviewGuide" || INVESTIGATING_DRIVERS.has(driver)) &&
                !exhaustedUsageWindow(provider, now, defaultTextGenerationModel(driver))
              );
            },
            { includeConfiguredInstances: true },
          ) ?? selection;
      }
    }
    return yield* resolveInstance(registry, operation, selection.instanceId).pipe(
      Effect.flatMap((service) => invoke(service, selection)),
    );
  });
  return {
    checkDecisionWriter: Effect.fn("TextGeneration.checkDecisionWriter")(function (input) {
      return resolveInstance(registry, "checkDecisionWriter", input.modelSelection.instanceId).pipe(
        Effect.flatMap(
          (textGeneration) =>
            textGeneration.checkDecisionWriter?.(input) ??
            Effect.succeed({
              supported: false,
              reason: "This provider does not support isolated Decisions writing.",
            }),
        ),
      );
    }),
    generateDecisionNotes: Effect.fn("TextGeneration.generateDecisionNotes")(function (input) {
      return resolveInstance(
        registry,
        "generateDecisionNotes",
        input.modelSelection.instanceId,
      ).pipe(
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
      );
    }),
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return generate("generateCommitMessage", input.modelSelection, (service, modelSelection) =>
        service.generateCommitMessage({ ...input, modelSelection }),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return generate("generatePrContent", input.modelSelection, (service, modelSelection) =>
        service.generatePrContent({ ...input, modelSelection }),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return generate("generateBranchName", input.modelSelection, (service, modelSelection) =>
        service.generateBranchName({ ...input, modelSelection }),
      );
    }),
    generateContextualSummary: Effect.fn("TextGeneration.generateContextualSummary")(
      function (input) {
        return resolveInstance(
          registry,
          "generateContextualSummary",
          input.modelSelection.instanceId,
        ).pipe(
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
        );
      },
    ),
    // Fails rather than falling back, so callers can treat this error as "unsupported" and keep
    // the deterministic summary.
    generateSquireTurnSummary: Effect.fn("TextGeneration.generateSquireTurnSummary")(
      function (input) {
        return resolveInstance(
          registry,
          "generateSquireTurnSummary",
          input.modelSelection.instanceId,
        ).pipe(
          Effect.flatMap(
            (generation) =>
              generation.generateSquireTurnSummary?.(input) ??
              Effect.fail(
                new TextGenerationError({
                  operation: "generateSquireTurnSummary",
                  detail: "This provider does not support isolated Squire summaries.",
                }),
              ),
          ),
        );
      },
    ),
    generateWorkflowSummary: Effect.fn("TextGeneration.generateWorkflowSummary")(function (input) {
      return resolveInstance(
        registry,
        "generateWorkflowSummary",
        input.modelSelection.instanceId,
      ).pipe(Effect.flatMap((textGeneration) => textGeneration.generateWorkflowSummary(input)));
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return generate("generateReviewGuide", input.modelSelection, (service, modelSelection) =>
        service.generateReviewGuide({ ...input, modelSelection }),
      );
    }),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return generate(
        "generateThreadTitle",
        input.modelSelection,
        (textGeneration, modelSelection) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({
              ...input,
              linkedContext,
              modelSelection,
            });
          }),
      );
    }),
  };
};

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  return makeTextGenerationFromRegistry(registry, sourceControl, serverSettings);
});

export const layer = Layer.effect(TextGeneration, make);
