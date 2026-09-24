import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  type CodexSettings,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ModelSelection,
  TextGenerationError,
} from "@lecturn/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@lecturn/shared/git";
import { resolveSpawnCommand } from "@lecturn/shared/shell";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { codexExecLaunchArgs, resolveCodexLaunchArgs } from "../provider/Layers/codexLaunchArgs.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildDecisionNotesPrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
  buildWorkflowSummaryPrompt,
  normalizeWorkflowSummary,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toCodexJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import { getModelSelectionStringOptionValue } from "@lecturn/shared/model";
import { prepareCodexInferenceIsolation } from "./CodexInferenceIsolation.ts";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";

const CODEX_INFERENCE_CONFIG = [
  "features.view_image=false",
  "features.tool_suggest=false",
  "features.deferred_executor=false",
  "features.send_message_to_user_async=false",
  "features.request_permissions_tool=false",
  "features.token_budget=false",
  "features.current_time_reminder=false",
  "features.sleep_tool=false",
  "features.code_mode=false",
  "features.code_mode_only=false",
  "tools.update_plan.enabled=false",
  "tools.experimental_request_user_input.enabled=false",

  'developer_instructions=""',
  "features.hooks=false",
  "notify=[]",
  "project_doc_max_bytes=0",
  "include_environment_context=false",
  "include_collaboration_mode_instructions=false",
  "features.memories=false",
  "features.plugins=false",
  "features.apps=false",
  "features.skip_host_skill_discovery=true",
  "features.shell_tool=false",
  "features.multi_agent=false",
  "features.multi_agent_v2=false",
  "features.browser_use=false",
  "features.computer_use=false",
  "features.image_generation=false",
  'web_search="disabled"',
];
const CODEX_TIMEOUT_MS = 180_000;
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
/**
 * Build a Codex text-generation closure bound to a specific `CodexSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  codexConfig: CodexSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
  const resolvedEnvironment = environment ?? process.env;

  const prepareIsolation = (input: Parameters<typeof prepareCodexInferenceIsolation>[0]) =>
    prepareCodexInferenceIsolation(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
    );

  type MaterializedImageAttachments = {
    readonly imagePaths: ReadonlyArray<string>;
  };

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError, Scope.Scope> =>
    fileSystem
      .makeTempFileScoped({
        prefix: `lecturn-${prefix}-${process.pid}-`,
      })
      .pipe(
        Effect.tap((filePath) => fileSystem.writeFileString(filePath, content)),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to write temp file`,
              ...(operation === "generateWorkflowSummary" || operation === "generateDecisionNotes"
                ? {}
                : { cause }),
            }),
        ),
      );

  const safeUnlink = (filePath: string): Effect.Effect<void, never> =>
    fileSystem.remove(filePath).pipe(Effect.catch(() => Effect.void));

  const encodeJsonForOperation = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateWorkflowSummary"
      | "generateDecisionNotes",
    value: unknown,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to encode structured output schema.",
            ...(operation === "generateWorkflowSummary" || operation === "generateDecisionNotes"
              ? {}
              : { cause }),
          }),
      ),
    );

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    _operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateWorkflowSummary"
      | "generateDecisionNotes",
    attachments: TextGeneration.BranchNameGenerationInput["attachments"],
  ): Effect.fn.Return<MaterializedImageAttachments, TextGenerationError> {
    if (!attachments || attachments.length === 0) {
      return { imagePaths: [] };
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem.stat(resolvedPath).pipe(Effect.orElseSucceed(() => null));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return { imagePaths };
  });

  const runCodexJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    imagePaths = [],
    cleanupPaths = [],
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateWorkflowSummary"
      | "generateDecisionNotes";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    imagePaths?: ReadonlyArray<string>;
    cleanupPaths?: ReadonlyArray<string>;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const schemaJson = yield* encodeJsonForOperation(
      operation,
      toCodexJsonSchemaObject(outputSchemaJson),
    );
    const schemaPath = yield* writeTempFile(operation, "codex-schema", schemaJson);
    const outputPath = yield* writeTempFile(operation, "codex-output", "");

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* () {
      const inference =
        operation === "generateWorkflowSummary" || operation === "generateDecisionNotes";
      const commandCwd = inference
        ? yield* fileSystem.makeTempDirectoryScoped({ prefix: "lecturn-workflow-inference-" }).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Could not isolate workflow inference.",
                  ...(operation === "generateWorkflowSummary" ||
                  operation === "generateDecisionNotes"
                    ? {}
                    : { cause }),
                }),
            ),
          )
        : cwd;
      const launchArgs = resolveCodexLaunchArgs(codexConfig.launchArgs, resolvedEnvironment);
      const inferenceInstructions = inference
        ? yield* writeTempFile(
            operation,
            "workflow-instructions",
            "Classify only the supplied conversation and return the requested JSON. Do not use tools or external context.",
          ).pipe(Effect.flatMap((filePath) => encodeJsonForOperation(operation, filePath)))
        : undefined;
      const reasoningEffort =
        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
        (operation === "generateDecisionNotes"
          ? undefined
          : DEFAULT_TEXT_GENERATION_REASONING_EFFORT);
      const serviceTier = getCodexServiceTierOptionValue(modelSelection);
      const commandEnvironment = {
        ...resolvedEnvironment,
        ...(codexConfig.homePath ? { CODEX_HOME: expandHomePath(codexConfig.homePath) } : {}),
      };
      const inferenceArgs = inference
        ? [`model_instructions_file=${inferenceInstructions}`, ...CODEX_INFERENCE_CONFIG].flatMap(
            (value) => ["--config", value],
          )
        : [];
      const isolation = inference
        ? yield* prepareIsolation({
            binary: codexConfig.binaryPath || "codex",
            args: [...codexExecLaunchArgs(launchArgs), ...inferenceArgs],
            env: commandEnvironment,
            cwd: commandCwd,
            operation,
            model: modelSelection.model,
          })
        : undefined;
      yield* isolation?.verify ?? Effect.void;
      const spawnCommand = yield* resolveSpawnCommand(
        codexConfig.binaryPath || "codex",
        [
          "exec",
          ...codexExecLaunchArgs(launchArgs),
          ...(inference ? ["--ignore-rules", ...inferenceArgs, ...(isolation?.args ?? [])] : []),
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "--model",
          modelSelection.model,
          ...(reasoningEffort ? ["--config", `model_reasoning_effort="${reasoningEffort}"`] : []),
          ...(serviceTier ? ["--config", `service_tier="${serviceTier}"`] : []),
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        { env: resolvedEnvironment },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: commandEnvironment,
        cwd: commandCwd,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to read Codex CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      yield* isolation?.verify ?? Effect.void;
      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            !inference && detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
    });

    const cleanup = Effect.all(
      [schemaPath, outputPath, ...cleanupPaths].map((filePath) => safeUnlink(filePath)),
      {
        concurrency: "unbounded",
      },
    ).pipe(Effect.asVoid);

    return yield* Effect.gen(function* () {
      yield* runCodexCommand().pipe(
        Effect.scoped,
        Effect.timeoutOption(CODEX_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson), {
        onExcessProperty: operation === "generateDecisionNotes" ? "error" : "ignore",
      });

      return yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read Codex output file.",
              ...(operation === "generateWorkflowSummary" || operation === "generateDecisionNotes"
                ? {}
                : { cause }),
            }),
        ),
        Effect.flatMap(decodeOutput),
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Codex returned invalid structured output.",
                ...(operation === "generateWorkflowSummary" || operation === "generateDecisionNotes"
                  ? {}
                  : { cause }),
              }),
            ),
        }),
      );
    }).pipe(Effect.ensuring(cleanup));
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CodexTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runCodexJson({
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
    Effect.fn("CodexTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runCodexJson({
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
    Effect.fn("CodexTextGeneration.generateBranchName")(function* (input) {
      const { imagePaths } = yield* materializeImageAttachments(
        "generateBranchName",
        input.attachments,
      );
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCodexJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        imagePaths,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CodexTextGeneration.generateThreadTitle")(function* (input) {
      const { imagePaths } = yield* materializeImageAttachments(
        "generateThreadTitle",
        input.attachments,
      );
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runCodexJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        imagePaths,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  const generateWorkflowSummary: TextGeneration.TextGeneration["Service"]["generateWorkflowSummary"] =
    Effect.fn("CodexTextGeneration.generateWorkflowSummary")(function* (input) {
      const { prompt, outputSchema } = yield* Effect.try({
        try: () => buildWorkflowSummaryPrompt(input),
        catch: () =>
          new TextGenerationError({
            operation: "generateWorkflowSummary",
            detail: "Workflow inference requires a prior summary and completed textual turns.",
          }),
      });
      const generated = yield* runCodexJson({
        operation: "generateWorkflowSummary",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        imagePaths: [],
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

  const checkDecisionWriter: NonNullable<
    TextGeneration.TextGeneration["Service"]["checkDecisionWriter"]
  > = Effect.fn("CodexTextGeneration.checkDecisionWriter")(
    function* (input) {
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "lecturn-decision-preflight-" })
        .pipe(
          Effect.mapError(
            () =>
              new TextGenerationError({
                operation: "checkDecisionWriter",
                detail: "Could not isolate Codex preflight.",
              }),
          ),
        );
      const isolation = yield* prepareIsolation({
        binary: codexConfig.binaryPath || "codex",
        args: [
          ...codexExecLaunchArgs(
            resolveCodexLaunchArgs(codexConfig.launchArgs, resolvedEnvironment),
          ),
          ...CODEX_INFERENCE_CONFIG.flatMap((value) => ["--config", value]),
        ],
        env: {
          ...resolvedEnvironment,
          ...(codexConfig.homePath ? { CODEX_HOME: expandHomePath(codexConfig.homePath) } : {}),
        },
        cwd,
        operation: "checkDecisionWriter",
        model: input.modelSelection.model,
      });
      yield* isolation.verify;
      return { supported: true, reason: null };
    },
    Effect.scoped,
    Effect.catch((error) => Effect.succeed({ supported: false, reason: error.detail })),
  );

  const generateDecisionNotes: NonNullable<
    TextGeneration.TextGeneration["Service"]["generateDecisionNotes"]
  > = Effect.fn("CodexTextGeneration.generateDecisionNotes")(function* (input) {
    const { prompt, outputSchema } = yield* Effect.try({
      try: () => buildDecisionNotesPrompt(input),
      catch: () =>
        new TextGenerationError({
          operation: "generateDecisionNotes",
          detail: "Decision writing requires bounded valid evidence.",
        }),
    });
    return yield* runCodexJson({
      operation: "generateDecisionNotes",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
  });

  return {
    generateDecisionNotes,
    checkDecisionWriter,
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateWorkflowSummary,
  } satisfies TextGeneration.TextGeneration["Service"];
});
