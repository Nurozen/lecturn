import * as DisplaySummary from "../contextual/ContextualDisplaySummary.ts";
import * as DecisionRelations from "../threadDecisions/DecisionRelations.ts";
import * as Lifecycle from "../contextual/ContextualLifecycle.ts";
import { Effect, Layer } from "effect";
import * as Runtime from "../extensions/ExtensionsRuntime.ts";
import * as Cloud from "../extensions/ExtensionsCloudClient.ts";
import * as Settings from "../contextual/ContextualSettings.ts";
import * as Repository from "../contextual/ContextualRepository.ts";
import * as Candidates from "../contextual/DecisionCandidates.ts";
import * as Notifications from "../contextual/ContextualNotifications.ts";
import * as Purge from "../contextual/ContextualPurge.ts";
import * as Groups from "../contextual/ContextualGroups.ts";
import * as Service from "../contextual/ContextualService.ts";
import * as Queue from "../contextual/ContextualTurnQueue.ts";
import * as Coordinator from "../contextual/ContextualTurnCoordinator.ts";
import * as TurnHooks from "../contextual/ContextualTurnHooks.ts";
import { LecturnOrchestrationHooks } from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import { ProviderWorkAdmission } from "../provider/ProviderWorkAdmission.ts";
import { makeProviderWorkAdmissionContribution } from "../provider/ProviderWorkAdmissionHooks.ts";

const base = Layer.mergeAll(
  Runtime.layer,
  Cloud.layer,
  Notifications.layer,
  Settings.layer,
  Repository.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Notifications.layer,
        DisplaySummary.layer.pipe(Layer.provide(Notifications.layer)),
      ),
    ),
  ),
  Queue.layer,
  Candidates.layer,
  Lifecycle.layer,
);
const groupDependencies = Layer.mergeAll(Purge.layer, Groups.layer).pipe(Layer.provideMerge(base));
const dependencies = DecisionRelations.layer.pipe(Layer.provideMerge(groupDependencies));
const service = Service.layer.pipe(Layer.provideMerge(dependencies));
const coordinated = Coordinator.layer.pipe(Layer.provideMerge(service));
/** Keep this exact object shared by the turn hooks and RPC handlers. */
export const layer = TurnHooks.layer.pipe(Layer.provideMerge(coordinated));

/**
 * Registers the Lecturn turn hooks owned by this area on the V2 runtime's hook
 * registry, in order: Contextual first (preparation and conflict holds happen
 * before the provider is claimed), then provider work admission (foreground
 * claim right before the provider turn). Also recovers uncertain Contextual
 * dispatches and starts the compaction tail.
 *
 * Requires: LecturnOrchestrationHooks (the instance OrchestrationV2 outputs),
 * ProviderWorkAdmission (the instance decisions use), ContextualTurnHooks
 * (`layer` above) and OrchestrationEventStore.
 */
export const hooksLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const hooks = yield* LecturnOrchestrationHooks;
    const contextual = yield* TurnHooks.ContextualTurnHooks;
    const admission = yield* ProviderWorkAdmission;
    yield* contextual.recover.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Contextual recovery failed", { cause })),
    );
    yield* hooks.register(contextual.contribution);
    yield* hooks.register(makeProviderWorkAdmissionContribution(admission));
    yield* contextual.observeCompactions.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Contextual compaction tail stopped", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
);
