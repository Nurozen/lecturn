import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type CursorSettings, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
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
import {
  applyCursorAcpModelSelection,
  makeCursorAcpRuntime,
} from "../provider/acp/CursorAcpSupport.ts";

const CURSOR_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Build a Cursor text-generation closure bound to a specific `CursorSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeCursorTextGeneration = Effect.fn("makeCursorTextGeneration")(function* (
  cursorSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const resolvedEnvironment = environment ?? process.env;

  const runCursorJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateWorkflowSummary";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const inference = operation === "generateWorkflowSummary";
      const commandCwd = inference
        ? yield* fileSystem.makeTempDirectoryScoped({ prefix: "lecturn-workflow-inference-" }).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Could not isolate workflow inference.",
                  cause,
                }),
            ),
          )
        : cwd;
      const usedToolRef = yield* Ref.make(false);
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeCursorAcpRuntime({
        cursorSettings,
        environment: resolvedEnvironment,
        childProcessSpawner: commandSpawner,
        cwd: commandCwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (
          inference &&
          (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
        ) {
          return Ref.set(usedToolRef, true);
        }
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const promptResult = yield* Effect.gen(function* () {
        yield* runtime.start();
        yield* Effect.ignore(runtime.setMode("ask"));
        yield* applyCursorAcpModelSelection({
          runtime,
          model: modelSelection.model,
          selections: modelSelection.options,
          mapError: ({ cause, configId, step }) =>
            new TextGenerationError({
              operation,
              detail:
                step === "set-config-option"
                  ? `Failed to set Cursor ACP config option "${configId}" for text generation.`
                  : "Failed to set Cursor ACP base model for text generation.",
              cause,
            }),
        });

        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(CURSOR_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Cursor Agent request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Cursor ACP request failed.",
                cause,
              }),
        ),
      );

      if (inference && (yield* Ref.get(usedToolRef))) {
        return yield* new TextGenerationError({
          operation,
          detail: "Workflow inference used a tool; the result was discarded.",
        });
      }
      const rawResult = (yield* Ref.get(outputRef)).trim();
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Cursor ACP request was cancelled."
              : "Cursor Agent returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(rawResult)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Cursor Agent returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Cursor ACP text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CursorTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runCursorJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
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
    Effect.fn("CursorTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runCursorJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CursorTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCursorJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CursorTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runCursorJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  const generateWorkflowSummary: TextGeneration.TextGeneration["Service"]["generateWorkflowSummary"] =
    Effect.fn("CursorTextGeneration.generateWorkflowSummary")(function* (input) {
      const { prompt, outputSchema } = yield* Effect.try({
        try: () => buildWorkflowSummaryPrompt(input),
        catch: (cause) =>
          new TextGenerationError({
            operation: "generateWorkflowSummary",
            detail: "Workflow inference requires a prior summary and completed textual turns.",
            cause,
          }),
      });
      const generated = yield* runCursorJson({
        operation: "generateWorkflowSummary",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      const summary = normalizeWorkflowSummary(generated.summary);
      if (!summary)
        return yield* new TextGenerationError({
          operation: "generateWorkflowSummary",
          detail: "The provider returned an empty workflow summary.",
        });
      return { summary, stage: generated.stage, confidence: generated.confidence };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateWorkflowSummary,
  } satisfies TextGeneration.TextGeneration["Service"];
});
