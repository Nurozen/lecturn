import {
  decisionWriterInputFixture,
  decisionWriterOutputFixture,
} from "./decisionWriterTestFixtures.ts";
import * as Result from "effect/Result";
import {
  squireSummaryExpectedFixture,
  squireSummaryInputFixture,
} from "./squireSummaryTestFixtures.ts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId } from "@lecturn/contracts";
import { createModelSelection } from "@lecturn/shared/model";

import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";

const makeStubTextGeneration = (
  overrides: Partial<TextGeneration.TextGeneration["Service"]>,
): TextGeneration.TextGeneration["Service"] =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () =>
      Effect.die("generateCommitMessage stub not configured for this test"),
    generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
    generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
    generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
    generateWorkflowSummary: () => Effect.die("generateWorkflowSummary stub not configured"),
    generateReviewGuide: () => Effect.die("generateReviewGuide stub not configured for this test"),
    ...overrides,
  });

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGeneration.TextGeneration["Service"],
): ProviderInstance =>
  ({
    instanceId,
    driverKind: instanceId as unknown as ProviderInstance["driverKind"],
    continuationIdentity: {
      driverKind: instanceId as unknown as ProviderInstance["driverKind"],
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration,
  }) satisfies ProviderInstance;

// Routing tests never put links in thread-title messages, so no lookup may run.
const noLinkSourceControl = {
  resolveLink: () => undefined,
} as unknown as SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistry.ProviderInstanceRegistry["Service"] => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

describe("makeTextGenerationFromRegistry", () => {
  it.effect("routes decision preflight and generation only to the exact enabled instance", () =>
    Effect.gen(function* () {
      const input = { ...decisionWriterInputFixture, cwd: process.cwd() };
      const calls: unknown[] = [];
      const instance = makeStubInstance(
        input.modelSelection.instanceId,
        makeStubTextGeneration({
          checkDecisionWriter: (value) => {
            calls.push(value.modelSelection);
            return Effect.succeed({ supported: true, reason: null });
          },
          generateDecisionNotes: (value) => {
            calls.push(value);
            return Effect.succeed(decisionWriterOutputFixture);
          },
        }),
      );
      const service = TextGeneration.makeTextGenerationFromRegistry(
        makeStubRegistry([instance]),
        noLinkSourceControl,
      );
      expect(yield* service.checkDecisionWriter(input)).toEqual({ supported: true, reason: null });
      expect(yield* service.generateDecisionNotes(input)).toEqual(decisionWriterOutputFixture);
      expect(calls).toEqual([input.modelSelection, input]);
      const disabled = TextGeneration.makeTextGenerationFromRegistry(
        makeStubRegistry([{ ...instance, enabled: false }]),
        noLinkSourceControl,
      );
      expect((yield* disabled.checkDecisionWriter(input).pipe(Effect.flip)).detail).toContain(
        "No enabled provider",
      );
      expect(calls).toHaveLength(2);
    }),
  );

  it.effect("fails closed when the selected adapter lacks isolated decision writing", () =>
    Effect.gen(function* () {
      const input = { ...decisionWriterInputFixture, cwd: process.cwd() };
      const service = TextGeneration.makeTextGenerationFromRegistry(
        makeStubRegistry([
          makeStubInstance(input.modelSelection.instanceId, makeStubTextGeneration({})),
        ]),
        noLinkSourceControl,
      );
      expect((yield* service.checkDecisionWriter(input)).supported).toBe(false);
      expect((yield* service.generateDecisionNotes(input).pipe(Effect.flip)).detail).toContain(
        "does not support isolated Decisions",
      );
    }),
  );

  it.effect(
    "routes display summaries to the configured instance and fails closed on unsupported adapters",
    () =>
      Effect.gen(function* () {
        const id = ProviderInstanceId.make("display-summary-provider");
        const input = {
          cwd: "/",
          message: "Original evidence",
          modelSelection: { instanceId: id, model: "selected-model" },
        };
        let calls = 0;
        const service = TextGeneration.makeTextGenerationFromRegistry(
          makeStubRegistry([
            makeStubInstance(
              id,
              makeStubTextGeneration({
                generateContextualSummary: (received) => {
                  calls++;
                  expect(received).toEqual(input);
                  return Effect.succeed({ text: "A display summary" });
                },
              }),
            ),
          ]),
          noLinkSourceControl,
        );
        expect(yield* service.generateContextualSummary(input)).toEqual({
          text: "A display summary",
        });
        expect(calls).toBe(1);
        const unsupported = TextGeneration.makeTextGenerationFromRegistry(
          makeStubRegistry([makeStubInstance(id, makeStubTextGeneration({}))]),
          noLinkSourceControl,
        );
        expect(
          (yield* unsupported.generateContextualSummary(input).pipe(Effect.flip)).detail,
        ).toContain("does not support isolated");
      }),
  );

  it.effect("routes Squire turn summaries and fails closed on unsupported adapters", () =>
    Effect.gen(function* () {
      const id = ProviderInstanceId.make("squire-summary-provider");
      const input = {
        cwd: "/",
        summaryInput: squireSummaryInputFixture,
        outcome: "finished" as const,
        modelSelection: { instanceId: id, model: "selected-model" },
      };
      const service = TextGeneration.makeTextGenerationFromRegistry(
        makeStubRegistry([
          makeStubInstance(
            id,
            makeStubTextGeneration({
              generateSquireTurnSummary: (received) => {
                expect(received).toEqual(input);
                return Effect.succeed(squireSummaryExpectedFixture);
              },
            }),
          ),
        ]),
        noLinkSourceControl,
      );
      expect(yield* service.generateSquireTurnSummary(input)).toEqual(squireSummaryExpectedFixture);
      const unsupported = TextGeneration.makeTextGenerationFromRegistry(
        makeStubRegistry([makeStubInstance(id, makeStubTextGeneration({}))]),
        noLinkSourceControl,
      );
      expect((yield* unsupported.generateSquireTurnSummary(input).pipe(Effect.flip)).detail).toBe(
        "This provider does not support isolated Squire summaries.",
      );
    }),
  );

  it.effect("routes workflow summaries through the selected provider instance", () =>
    Effect.gen(function* () {
      const id = ProviderInstanceId.make("summary-provider");
      const instance = makeStubInstance(
        id,
        makeStubTextGeneration({
          generateWorkflowSummary: (input) =>
            Effect.succeed({
              summary: `${input.modelSelection.model}: ${input.message}`,
              stage: "build",
              confidence: 0.8,
            }),
        }),
      );
      const service = TextGeneration.makeTextGenerationFromRegistry(
        makeStubRegistry([instance]),
        noLinkSourceControl,
      );
      const result = yield* service.generateWorkflowSummary({
        cwd: process.cwd(),
        message: "CI pending",
        modelSelection: createModelSelection(id, "selected-model"),
      });
      expect(result.summary).toBe("selected-model: CI pending");
      const missing = yield* service
        .generateWorkflowSummary({
          cwd: process.cwd(),
          message: "CI pending",
          modelSelection: createModelSelection(ProviderInstanceId.make("absent"), "selected-model"),
        })
        .pipe(Effect.result);
      expect(Result.isFailure(missing)).toBe(true);
      if (Result.isFailure(missing))
        expect(missing.failure.operation).toBe("generateWorkflowSummary");
    }),
  );
});
