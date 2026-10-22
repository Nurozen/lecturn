/**
 * The text generation operations every provider shares. A provider supplies a
 * runner that sends one prompt and decodes the reply; prompts, linked source
 * control context, and output sanitizing live here so providers cannot drift
 * on them.
 *
 * @module textGeneration/TextGenerationOperations
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type ChatAttachment, type ModelSelection, TextGenerationError } from "@lecturn/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@lecturn/shared/git";
import { extractJsonObject } from "@lecturn/shared/schemaJson";

import type * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildContextualSummaryPrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
  buildWorkflowSummaryPrompt,
  normalizeWorkflowSummary,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

export type Operation = keyof TextGeneration.TextGeneration["Service"];

/** One prompt for a provider to run. */
export interface Request<S extends Schema.Top> {
  readonly operation: Operation;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
  /** The user's attachments, already listed in the prompt. Providers that accept images send them. */
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
}

/** Runs one request and decodes the reply as its `outputSchema`. */
export type Runner = <S extends Schema.Top>(
  request: Request<S>,
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

/** Decodes the JSON object in a text reply, which models often wrap in prose. */
export const decodeJsonReply = <S extends Schema.Top>(
  request: Pick<Request<S>, "operation" | "outputSchema">,
  provider: string,
  text: string,
) => {
  // Each request builds its own output schema, so the decoder cannot be hoisted.
  const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(request.outputSchema));
  return decodeOutput(extractJsonObject(text)).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation: request.operation,
          detail: `${provider} returned invalid structured output.`,
          cause,
        }),
    ),
  );
};

/** The text generation service over `run`. `name` prefixes each operation's span. */
export function fromRunner(name: string, run: Runner): TextGeneration.TextGeneration["Service"] {
  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn(`${name}.generateCommitMessage`)(function* (input) {
      const generated = yield* run({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        }),
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn(`${name}.generatePrContent`)(function* (input) {
      const generated = yield* run({
        operation: "generatePrContent",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...buildPrContentPrompt({
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          policy: input.policy,
          changeRequestTemplate: input.changeRequestTemplate,
        }),
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn(`${name}.generateBranchName`)(function* (input) {
      const generated = yield* run({
        operation: "generateBranchName",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
        ...buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
          naming: input.naming,
        }),
      });
      return { branch: formatGeneratedBranchName(generated.branch, input.naming) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn(`${name}.generateThreadTitle`)(function* (input) {
      const generated = yield* run({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
        ...buildThreadTitlePrompt({
          message: input.message,
          previousTitle: input.previousTitle,
          linkedContext: input.linkedContext,
          attachments: input.attachments,
        }),
      });
      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });

  const generateWorkflowSummary: TextGeneration.TextGeneration["Service"]["generateWorkflowSummary"] =
    Effect.fn(`${name}.generateWorkflowSummary`)(function* (input) {
      // The decode cause can quote the conversation, so it stays out of the error.
      const request = yield* Effect.try({
        try: () => buildWorkflowSummaryPrompt(input),
        catch: () =>
          new TextGenerationError({
            operation: "generateWorkflowSummary",
            detail: "Workflow inference requires a prior summary and completed textual turns.",
          }),
      });
      const generated = yield* run({
        operation: "generateWorkflowSummary",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...request,
      });
      const summary = normalizeWorkflowSummary(generated.summary);
      if (!summary) {
        return yield* new TextGenerationError({
          operation: "generateWorkflowSummary",
          detail: "The provider returned an empty workflow summary.",
        });
      }
      return { summary, stage: generated.stage, confidence: generated.confidence };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateWorkflowSummary,
  } satisfies TextGeneration.TextGeneration["Service"];
}

/**
 * Contextual summaries over `run`. Only providers whose runner isolates the
 * request from the checkout, tools, and session history may offer this.
 */
export function contextualSummaryFromRunner(
  name: string,
  run: Runner,
): NonNullable<TextGeneration.TextGeneration["Service"]["generateContextualSummary"]> {
  return Effect.fn(`${name}.generateContextualSummary`)(
    function* (input) {
      const request = yield* Effect.try({
        try: () => buildContextualSummaryPrompt(input),
        catch: () =>
          new TextGenerationError({
            operation: "generateContextualSummary",
            detail: "Contextual summary requires bounded evidence text.",
          }),
      });
      const generated = yield* run({
        operation: "generateContextualSummary",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...request,
      });
      const text = generated.text.trim();
      if (!text) {
        return yield* new TextGenerationError({
          operation: "generateContextualSummary",
          detail: "The provider returned an empty Contextual summary.",
        });
      }
      return { text };
    },
    // Contextual callers surface one stable message; provider detail stays in traces.
    Effect.mapError(
      () =>
        new TextGenerationError({
          operation: "generateContextualSummary",
          detail: "Contextual summary generation is unavailable.",
        }),
    ),
  );
}
