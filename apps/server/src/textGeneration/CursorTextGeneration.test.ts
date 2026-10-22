import type { RunResult, SendOptions } from "@cursor/sdk";
import { CursorSettings, ProviderInstanceId, TextGenerationError } from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@lecturn/shared/model";
import { beforeEach, vi } from "vite-plus/test";

import { makeCursorTextGeneration } from "./CursorTextGeneration.ts";

const cursorSdkMock = vi.hoisted(() => ({
  create: vi.fn<(options: unknown) => Promise<unknown>>(),
  send: vi.fn<(prompt: string, options?: SendOptions) => Promise<unknown>>(),
  toolStep: false,
  close: vi.fn(),
  cancel: vi.fn(async () => {}),
  prompt: vi.fn<(prompt: string, options: unknown) => Promise<RunResult>>(async () => ({
    id: "run-cursor-text-generation-test",
    status: "finished",
    result:
      '{"subject":"Add generated commit message","body":"- verify cursor sdk text generation"}',
  })),
}));

vi.mock("../provider/cursorSdk.ts", () => ({ Agent: { create: cursorSdkMock.create } }));

let hasCustomPolicy = false;
const tempPrefixes: Array<string | undefined> = [];
const fsLayer = FileSystem.layerNoop({
  exists: () => Effect.succeed(hasCustomPolicy),
  makeTempDirectoryScoped: (options) => {
    tempPrefixes.push(options?.prefix);
    return Effect.succeed("/isolated-text-generation");
  },
});

const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const cursorSettings = decodeCursorSettings({ enabled: true });

beforeEach(() => {
  hasCustomPolicy = false;
  tempPrefixes.length = 0;
  cursorSdkMock.toolStep = false;
  cursorSdkMock.create.mockReset();
  cursorSdkMock.send.mockReset();
  cursorSdkMock.create.mockImplementation(async (options) => {
    cursorSdkMock.send.mockImplementation(async (prompt, sendOptions) => {
      if (cursorSdkMock.toolStep) {
        await sendOptions?.onStep?.({
          step: { type: "toolCall", message: { type: "read" } } as never,
        });
      }
      return {
        status: "running",
        cancel: cursorSdkMock.cancel,
        wait: () => cursorSdkMock.prompt(prompt, options),
      };
    });
    return {
      close: cursorSdkMock.close,
      [Symbol.asyncDispose]: async () => {
        cursorSdkMock.close();
      },
      send: cursorSdkMock.send,
    };
  });
  cursorSdkMock.close.mockClear();
  cursorSdkMock.cancel.mockClear();
  cursorSdkMock.prompt.mockReset();
  cursorSdkMock.prompt.mockResolvedValue({
    id: "run-cursor-text-generation-test",
    status: "finished",
    result:
      '{"subject":"Add generated commit message","body":"- verify cursor sdk text generation"}',
  });
});

describe("CursorTextGeneration", () => {
  it.effect("resolves the browser credential for every request after an account change", () =>
    Effect.gen(function* () {
      let apiKey = "first-browser-key";
      const generation = yield* makeCursorTextGeneration(
        cursorSettings,
        {},
        Effect.sync(() => apiKey),
      );
      const input = {
        cwd: process.cwd(),
        branch: "feature/cursor",
        stagedSummary: "M file.ts",
        stagedPatch: "diff",
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "auto"),
      };
      yield* generation.generateCommitMessage(input);
      expect(cursorSdkMock.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ apiKey: "first-browser-key" }),
      );
      apiKey = "second-browser-key";
      yield* generation.generateCommitMessage(input);
      expect(cursorSdkMock.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ apiKey: "second-browser-key" }),
      );
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("uses the Cursor SDK prompt API with model parameters and API key", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/cursor-text-generation",
        stagedSummary: "M apps/server/src/textGeneration/CursorTextGeneration.ts",
        stagedPatch:
          "diff --git a/apps/server/src/textGeneration/CursorTextGeneration.ts b/apps/server/src/textGeneration/CursorTextGeneration.ts",
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "gpt-5.4", [
          { id: "thinking", value: "high" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ]),
      });

      expect(generated.subject).toBe("Add generated commit message");
      expect(generated.body).toBe("- verify cursor sdk text generation");

      expect(cursorSdkMock.prompt).toHaveBeenCalledTimes(1);
      const [prompt, options] = (
        cursorSdkMock.prompt.mock.calls as unknown as Array<[string, unknown]>
      )[0]!;
      expect(prompt).toContain("Staged patch:");
      expect(options).toEqual({
        apiKey: "test-cursor-key",
        mode: "plan",
        model: {
          id: "gpt-5.4",
          params: [
            { id: "thinking", value: "high" },
            { id: "context", value: "1m" },
            { id: "fast", value: "true" },
          ],
        },
        local: {
          cwd: "/isolated-text-generation",
          autoReview: false,
          sandboxOptions: { enabled: true },
          settingSources: [],
          enableAgentRetries: true,
        },
      });
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("continues in the temp directory when the SDK cannot sandbox", () =>
    Effect.gen(function* () {
      cursorSdkMock.create.mockImplementationOnce(async () => {
        throw new Error(
          "Local SDK sandboxing was requested, but sandboxing is not supported in this environment. Disable local.sandboxOptions.enabled or remove ~/.cursor/sandbox.json to run without sandboxing.",
        );
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/cursor-text-generation",
        stagedSummary: "M apps/server/src/textGeneration/CursorTextGeneration.ts",
        stagedPatch: "diff --git a/apps/server/src/textGeneration/CursorTextGeneration.ts",
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "composer-2"),
      });

      expect(generated.subject).toBe("Add generated commit message");
      expect(cursorSdkMock.create).toHaveBeenCalledTimes(2);
      expect(cursorSdkMock.create.mock.calls[0]?.[0]).toMatchObject({
        local: { sandboxOptions: { enabled: true } },
      });
      expect(cursorSdkMock.create.mock.calls[1]?.[0]).toMatchObject({
        local: {
          cwd: "/isolated-text-generation",
          autoReview: false,
          sandboxOptions: { enabled: false },
          settingSources: [],
          enableAgentRetries: true,
        },
      });
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("does not retry Agent.create for errors other than an unsupported sandbox", () =>
    Effect.gen(function* () {
      cursorSdkMock.create.mockImplementationOnce(async () => {
        throw new Error("Cursor SDK network down");
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const error = yield* Effect.flip(
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/cursor-text-generation",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "composer-2"),
        }),
      );

      expect(error.detail).toBe("Cursor SDK text generation failed.");
      expect(cursorSdkMock.create).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("accepts json objects with extra assistant text around them", () =>
    Effect.gen(function* () {
      cursorSdkMock.prompt.mockResolvedValueOnce({
        id: "run-cursor-text-generation-test",
        status: "finished",
        result:
          'Sure, here is the JSON:\n```json\n{\n  "subject": "Update README dummy comment with attribution and date",\n  "body": ""\n}\n```\nDone.',
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/cursor-noisy-json",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
      });

      expect(generated.subject).toBe("Update README dummy comment with attribution and date");
      expect(generated.body).toBe("");
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("generates thread titles through Cursor SDK text generation", () =>
    Effect.gen(function* () {
      cursorSdkMock.prompt.mockResolvedValueOnce({
        id: "run-cursor-title-generation-test",
        status: "finished",
        result: '{"title":"\\"Trim reconnect spinner status after resume.\\""}',
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Fix the reconnect spinner after a resumed session.",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
      });

      expect(generated.title).toBe("Trim reconnect spinner status after resume.");
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect.each(["error", "cancelled"] as const)(
    "rejects a %s Cursor SDK run that includes valid title JSON",
    (status) =>
      Effect.gen(function* () {
        const promptResult = {
          id: "run-cursor-partial-title-test",
          status,
          result: '{"title":"Partial title from a failed run."}',
        } satisfies RunResult;
        cursorSdkMock.prompt.mockResolvedValueOnce(promptResult);
        const generation = yield* makeCursorTextGeneration(cursorSettings, {
          CURSOR_API_KEY: "test-cursor-key",
        });
        const failure = yield* Effect.flip(
          generation.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the reconnect spinner after a resumed session.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "composer-2",
            },
          }),
        );
        expect(failure).toBeInstanceOf(TextGenerationError);
        expect(failure.operation).toBe("generateThreadTitle");
        expect(failure.detail).toBe(
          status === "cancelled"
            ? "Cursor SDK request was cancelled."
            : "Cursor SDK request finished with an error.",
        );
        expect(cursorSdkMock.close).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("fails closed when ambient sandbox policy can expand write access", () =>
    Effect.gen(function* () {
      hasCustomPolicy = true;
      const generation = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      const failure = yield* Effect.flip(
        generation.generateThreadTitle({
          cwd: "/real-workspace",
          message: "Title",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
        }),
      );
      expect(failure.detail).toContain("custom ~/.cursor/sandbox.json");
      expect(cursorSdkMock.prompt).not.toHaveBeenCalled();
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("cancels the native run when text generation times out", () =>
    Effect.gen(function* () {
      let started!: () => void;
      const called = new Promise<void>((resolve) => {
        started = resolve;
      });
      cursorSdkMock.prompt.mockImplementationOnce(() => {
        started();
        return new Promise(() => {});
      });
      const generation = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      const result = yield* generation
        .generateThreadTitle({
          cwd: "/real-workspace",
          message: "Title",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
        })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.promise(() => called);
      yield* TestClock.adjust("180 seconds");
      expect((yield* Fiber.join(result)).detail).toContain("timed out");
      expect(cursorSdkMock.cancel).toHaveBeenCalledOnce();
      expect(cursorSdkMock.close).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(fsLayer), Effect.scoped),
  );

  it.effect.each(["create", "send"] as const)(
    "times out pending %s and releases its late SDK resource",
    (phase) =>
      Effect.gen(function* () {
        let started!: () => void;
        const called = new Promise<void>((resolve) => {
          started = resolve;
        });
        let resolveLate!: (resource: unknown) => void;
        const pending = new Promise<unknown>((resolve) => {
          resolveLate = resolve;
        });
        const wait = vi.fn();
        const agent = {
          close: cursorSdkMock.close,
          [Symbol.asyncDispose]: async () => {
            cursorSdkMock.close();
          },
          send: async () => {
            started();
            return pending;
          },
        };
        cursorSdkMock.create.mockImplementation(async () => {
          if (phase === "create") {
            started();
            return pending;
          }
          return agent;
        });
        const generation = yield* makeCursorTextGeneration(cursorSettings, {
          CURSOR_API_KEY: "key",
        });
        const result = yield* generation
          .generateThreadTitle({
            cwd: "/real-workspace",
            message: "Title",
            modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
          })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.promise(() => called);
        yield* TestClock.adjust("180 seconds");
        expect((yield* Fiber.join(result)).detail).toContain("timed out");
        let cleanup!: () => void;
        const cleaned = new Promise<void>((resolve) => {
          cleanup = resolve;
        });
        if (phase === "create") cursorSdkMock.close.mockImplementationOnce(cleanup);
        else
          cursorSdkMock.cancel.mockImplementationOnce(async () => {
            cleanup();
          });
        resolveLate(
          phase === "create" ? agent : { status: "running", cancel: cursorSdkMock.cancel, wait },
        );
        yield* Effect.promise(() => cleaned);
        expect(cursorSdkMock.close).toHaveBeenCalledOnce();
        expect(wait).not.toHaveBeenCalled();
        if (phase === "send") expect(cursorSdkMock.cancel).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(fsLayer), Effect.scoped),
  );

  it.effect("requires CURSOR_API_KEY before calling the SDK", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {});

      const error = yield* Effect.flip(
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/cursor-api-key",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            instanceId: ProviderInstanceId.make("cursor"),
            model: "composer-2",
          },
        }),
      );

      expect(error.detail).toBe("Sign in with Cursor or add CURSOR_API_KEY in provider settings.");
      expect(cursorSdkMock.prompt).not.toHaveBeenCalled();
    }).pipe(Effect.provide(fsLayer)),
  );
  const workflowInput = {
    cwd: "/real-workspace",
    message:
      '{"priorSummary":null,"turns":[{"question":"Implement the API","response":"API implemented; CI pending; approval absent."}]}',
    modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
  };

  it.effect.each([
    ["malformed JSON", "not JSON"],
    ["missing stage", '{"summary":"Working","confidence":0.8}'],
    ["missing confidence", '{"summary":"Working","stage":"build"}'],
    ["invalid stage", '{"summary":"Working","stage":"completed","confidence":0.8}'],
    ["confidence above one", '{"summary":"Working","stage":"build","confidence":1.1}'],
    ["negative confidence", '{"summary":"Working","stage":"build","confidence":-0.1}'],
  ] as const)("rejects workflow inference with %s", ([, output]) =>
    Effect.gen(function* () {
      cursorSdkMock.prompt.mockResolvedValueOnce({
        id: "run-cursor-workflow-invalid",
        status: "finished",
        result: output,
      });
      const generation = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "key",
      });
      const failure = yield* Effect.flip(generation.generateWorkflowSummary(workflowInput));
      expect(failure.operation).toBe("generateWorkflowSummary");
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("discards workflow inference when the run uses a tool", () =>
    Effect.gen(function* () {
      cursorSdkMock.toolStep = true;
      cursorSdkMock.prompt.mockResolvedValueOnce({
        id: "run-cursor-workflow-tool",
        status: "finished",
        result: '{"summary":"Ready","stage":"accept","confidence":0.8}',
      });
      const generation = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      const failure = yield* Effect.flip(generation.generateWorkflowSummary(workflowInput));
      expect(failure.detail).toContain("used a tool");
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("generates an isolated workflow summary without title truncation", () =>
    Effect.gen(function* () {
      cursorSdkMock.prompt.mockResolvedValueOnce({
        id: "run-cursor-workflow",
        status: "finished",
        result:
          '{"summary":" API complete.\\n CI remains pending. ","stage":"accept","confidence":0.8}',
      });
      const generation = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      const result = yield* generation.generateWorkflowSummary(workflowInput);
      expect(result).toEqual({
        summary: "API complete. CI remains pending.",
        stage: "accept",
        confidence: 0.8,
      });
      expect(tempPrefixes).toEqual(["lecturn-workflow-inference-"]);
      expect(cursorSdkMock.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mode: "plan",
          local: expect.objectContaining({ cwd: "/isolated-text-generation", settingSources: [] }),
        }),
      );
    }).pipe(Effect.provide(fsLayer)),
  );

  it.effect("names non-inference temp workspaces for Lecturn", () =>
    Effect.gen(function* () {
      cursorSdkMock.prompt.mockResolvedValueOnce({
        id: "run-cursor-title",
        status: "finished",
        result: '{"title":"Lecturn title"}',
      });
      const generation = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      yield* generation.generateThreadTitle({
        cwd: "/real-workspace",
        message: "Title",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
      });
      expect(tempPrefixes).toEqual(["lecturn-cursor-text-"]);
    }).pipe(Effect.provide(fsLayer)),
  );
});
