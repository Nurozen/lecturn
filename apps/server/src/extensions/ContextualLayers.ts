import * as DisplaySummary from "../contextual/ContextualDisplaySummary.ts";
import * as DecisionRelations from "../threadDecisions/DecisionRelations.ts";
import * as Lifecycle from "../orchestration/ContextualLifecycle.ts";
import { Layer } from "effect";
import * as Runtime from "../extensions/ExtensionsRuntime.ts";
import * as Cloud from "../extensions/ExtensionsCloudClient.ts";
import * as Settings from "../contextual/ContextualSettings.ts";
import * as Repository from "../contextual/ContextualRepository.ts";
import * as Candidates from "../contextual/DecisionCandidates.ts";
import * as Notifications from "../contextual/ContextualNotifications.ts";
import * as Purge from "../contextual/ContextualPurge.ts";
import * as Groups from "../contextual/ContextualGroups.ts";
import * as Service from "../contextual/ContextualService.ts";
import * as Queue from "../orchestration/ContextualTurnQueue.ts";
import * as Coordinator from "../orchestration/ContextualTurnCoordinator.ts";

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
/** Keep this exact object shared by reactors and RPC handlers. */
export const layer = Coordinator.layer.pipe(Layer.provideMerge(service));
