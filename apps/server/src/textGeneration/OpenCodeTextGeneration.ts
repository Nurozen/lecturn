import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  TextGenerationError,
  type ChatAttachment,
  type ModelSelection,
  type OpenCodeSettings,
} from "@lecturn/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@lecturn/shared/git";
import { getModelSelectionStringOptionValue } from "@lecturn/shared/model";
import { extractJsonObject } from "@lecturn/shared/schemaJson";

import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
  buildWorkflowSummaryPrompt,
  normalizeWorkflowSummary,
} from "./TextGenerationPrompts.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import * as OpenCodeRuntime from "../provider/opencodeRuntime.ts";
import * as OpenCodeServerOwner from "../provider/OpenCodeServerOwner.ts";

const WORKFLOW_INFERENCE_TIMEOUT_MS = 180_000;
const WORKFLOW_ABORT_TIMEOUT_MS = 5_000;

const OpenCodeTextGenerationOperation = Schema.Literals([
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
  "generateWorkflowSummary",
]);

type OpenCodeTextGenerationOperation = typeof OpenCodeTextGenerationOperation.Type;

const openCodeTextGenerationErrorContext = {
  operation: OpenCodeTextGenerationOperation,
  cwd: Schema.String,
};

export class OpenCodeTextGenerationSessionRequestError extends Schema.TaggedErrorClass<OpenCodeTextGenerationSessionRequestError>()(
  "OpenCodeTextGenerationSessionRequestError",
  {
    ...openCodeTextGenerationErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode session creation request failed for ${this.operation} in ${this.cwd}.`;
  }
}

export class OpenCodeTextGenerationSessionPayloadError extends Schema.TaggedErrorClass<OpenCodeTextGenerationSessionPayloadError>()(
  "OpenCodeTextGenerationSessionPayloadError",
  openCodeTextGenerationErrorContext,
) {
  override get message(): string {
    return `OpenCode session.create returned no session payload for ${this.operation} in ${this.cwd}.`;
  }
}

const openCodePromptErrorContext = {
  ...openCodeTextGenerationErrorContext,
  sessionId: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
};

export class OpenCodeTextGenerationPromptRequestError extends Schema.TaggedErrorClass<OpenCodeTextGenerationPromptRequestError>()(
  "OpenCodeTextGenerationPromptRequestError",
  {
    ...openCodePromptErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode prompt request failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}).`;
  }
}

export class OpenCodeTextGenerationPromptResponseError extends Schema.TaggedErrorClass<OpenCodeTextGenerationPromptResponseError>()(
  "OpenCodeTextGenerationPromptResponseError",
  {
    ...openCodePromptErrorContext,
    providerErrorName: Schema.optional(Schema.String),
    providerMessage: Schema.String,
  },
) {
  override get message(): string {
    const providerError = this.providerErrorName ? ` ${this.providerErrorName}` : "";
    return `OpenCode prompt${providerError} failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}): ${this.providerMessage}`;
  }
}

export class OpenCodeTextGenerationEmptyOutputError extends Schema.TaggedErrorClass<OpenCodeTextGenerationEmptyOutputError>()(
  "OpenCodeTextGenerationEmptyOutputError",
  {
    ...openCodePromptErrorContext,
    responsePartCount: NonNegativeInt,
    textPartCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `OpenCode returned empty output for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}, ${this.responsePartCount} response parts, ${this.textPartCount} text parts).`;
  }
}

interface OpenCodePromptFailure {
  readonly name?: string;
  readonly message: string;
}

interface OpenCodeTextPart {
  readonly type: "text";
  readonly text: string;
}

function getOpenCodePromptFailure(error: unknown): OpenCodePromptFailure | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const name =
    "name" in error && typeof error.name === "string" && error.name.trim().length > 0
      ? error.name.trim()
      : undefined;
  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
  if (message.length > 0) {
    return {
      ...(name ? { name } : {}),
      message,
    };
  }

  if (name) {
    return { name, message: name };
  }

  return null;
}

function isOpenCodeTextPart(part: unknown): part is OpenCodeTextPart {
  return (
    part !== null &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .filter(isOpenCodeTextPart)
    .map((part) => part.text)
    .join("")
    .trim();
}

export const makeOpenCodeTextGeneration = Effect.fn("makeOpenCodeTextGeneration")(function* (
  openCodeSettings: OpenCodeSettings,
) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverOwner = yield* OpenCodeServerOwner.OpenCodeServerOwner;

  const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(input: {
    readonly operation: OpenCodeTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }) {
    const inference = input.operation === "generateWorkflowSummary";
    const directory = inference
      ? yield* fileSystem.makeTempDirectoryScoped({ prefix: "lecturn-workflow-inference-" }).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Could not isolate workflow inference.",
                cause,
              }),
          ),
        )
      : input.cwd;
    const parsedModel = OpenCodeRuntime.parseOpenCodeModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode model selection must use the 'provider/model' format.",
      });
    }

    const fileParts = OpenCodeRuntime.toOpenCodeFileParts({
      attachments: input.attachments?.filter((attachment) => attachment.type === "image"),
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
    });

    const runAgainstServer = Effect.fn("runOpenCodeJson.runAgainstServer")(
      function* (
        server: Pick<
          OpenCodeRuntime.OpenCodeServerConnection,
          "url" | "serverPassword" | "version"
        >,
      ) {
        const client = openCodeRuntime.createOpenCodeSdkClient({
          baseUrl: server.url,
          directory,
          ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        });
        const session = yield* Effect.tryPromise({
          try: (signal) =>
            client.session.create(
              {
                title: `Lecturn ${input.operation}`,
                permission: [{ permission: "*", pattern: "*", action: "deny" }],
              },
              inference ? { signal } : undefined,
            ),
          catch: (cause) =>
            new OpenCodeTextGenerationSessionRequestError({
              operation: input.operation,
              cwd: input.cwd,
              cause,
            }),
        });
        if (!session.data) {
          return yield* new OpenCodeTextGenerationSessionPayloadError({
            operation: input.operation,
            cwd: input.cwd,
          });
        }
        const selectedAgent = inference
          ? undefined
          : getModelSelectionStringOptionValue(input.modelSelection, "agent");
        const selectedVariant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
        const promptContext = {
          operation: input.operation,
          cwd: input.cwd,
          sessionId: session.data.id,
          providerId: parsedModel.providerID,
          modelId: parsedModel.modelID,
        };

        const result = yield* Effect.tryPromise({
          try: (signal) =>
            client.session.prompt(
              {
                sessionID: session.data.id,
                model: parsedModel,
                ...(selectedAgent ? { agent: selectedAgent } : {}),
                ...(selectedVariant ? { variant: selectedVariant } : {}),
                parts: [{ type: "text", text: input.prompt }, ...fileParts],
              },
              inference ? { signal } : undefined,
            ),
          catch: (cause) =>
            new OpenCodeTextGenerationPromptRequestError({
              ...promptContext,
              cause,
            }),
        }).pipe(
          Effect.onInterrupt(() =>
            inference
              ? Effect.tryPromise({
                  try: (signal) => client.session.abort({ sessionID: session.data.id }, { signal }),
                  catch: (cause) =>
                    new TextGenerationError({
                      operation: input.operation,
                      detail: "Could not cancel OpenCode workflow inference.",
                      cause,
                    }),
                }).pipe(
                  // Cancellation is best effort; an unresponsive abort endpoint
                  // must not retain the shared summary queue either.
                  Effect.interruptible,
                  Effect.timeoutOption(WORKFLOW_ABORT_TIMEOUT_MS),
                  Effect.ignore,
                )
              : Effect.void,
          ),
        );
        const promptFailure = getOpenCodePromptFailure(result.data?.info?.error);
        if (promptFailure) {
          return yield* new OpenCodeTextGenerationPromptResponseError({
            ...promptContext,
            ...(promptFailure.name ? { providerErrorName: promptFailure.name } : {}),
            providerMessage: promptFailure.message,
          });
        }
        const responseParts = result.data?.parts ?? [];
        if (inference && responseParts.some((part) => part.type === "tool")) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Workflow inference used a tool; the result was discarded.",
          });
        }
        const rawText = getOpenCodeTextResponse(responseParts);
        if (rawText.length === 0) {
          return yield* new OpenCodeTextGenerationEmptyOutputError({
            ...promptContext,
            responsePartCount: responseParts.length,
            textPartCount: responseParts.filter(isOpenCodeTextPart).length,
          });
        }
        return rawText;
      },
      Effect.catchTags({
        OpenCodeTextGenerationSessionRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.create request failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationSessionPayloadError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.create returned no session payload.",
              cause,
            }),
          ),
        OpenCodeTextGenerationPromptRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.prompt request failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationPromptResponseError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: cause.providerMessage,
              cause,
            }),
          ),
        OpenCodeTextGenerationEmptyOutputError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode returned empty output.",
              cause,
            }),
          ),
      }),
    );

    const serverOutput =
      openCodeSettings.serverUrl.length > 0
        ? openCodeRuntime
            .connectToOpenCodeServer({
              binaryPath: openCodeSettings.binaryPath,
              directory,
              serverUrl: openCodeSettings.serverUrl,
              ...(openCodeSettings.serverPassword
                ? { serverPassword: openCodeSettings.serverPassword }
                : {}),
            })
            .pipe(Effect.flatMap(runAgainstServer), Effect.scoped)
        : serverOwner.withServer(runAgainstServer);
    const boundedServerOutput = inference
      ? serverOutput.pipe(
          Effect.timeoutOption(WORKFLOW_INFERENCE_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new TextGenerationError({
                    operation: input.operation,
                    detail: "OpenCode workflow inference timed out.",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        )
      : serverOutput;
    const rawOutput = yield* boundedServerOutput.pipe(
      Effect.catchTags({
        OpenCodeRuntimeError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
              cause,
            }),
          ),
      }),
    );

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(rawOutput)).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: "OpenCode returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  }, Effect.scoped);

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("OpenCodeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runOpenCodeJson({
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
    Effect.fn("OpenCodeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runOpenCodeJson({
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
    Effect.fn("OpenCodeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("OpenCodeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      };
    });

  const generateWorkflowSummary: TextGeneration.TextGeneration["Service"]["generateWorkflowSummary"] =
    Effect.fn("OpenCodeTextGeneration.generateWorkflowSummary")(function* (input) {
      const { prompt, outputSchema } = yield* Effect.try({
        try: () => buildWorkflowSummaryPrompt(input),
        catch: (cause) =>
          new TextGenerationError({
            operation: "generateWorkflowSummary",
            detail: "Workflow inference requires a prior summary and completed textual turns.",
            cause,
          }),
      });
      const generated = yield* runOpenCodeJson({
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
