/**
 * Everything is built whatever the switch says, so turning it on needs no restart: each service checks
 * `SquireSwitch` where it acts, and background work runs only during an on period.
 */
import * as HostProcess from "@lecturn/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventStoreV2 from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SquireActions from "./SquireActions.ts";
import * as SquireCiExcerpt from "./SquireCiExcerpt.ts";
import * as SquireClock from "./SquireClock.ts";
import * as SquireCompactionFloor from "./SquireCompactionFloor.ts";
import * as SquireContainers from "./SquireContainers.ts";
import * as SquireControl from "./SquireControl.ts";
import * as SquireCursorStartup from "./SquireCursorStartup.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import * as SquireDevFixtures from "./SquireDevFixtures.ts";
import * as SquireDigest from "./SquireDigest.ts";
import * as SquireItems from "./SquireItems.ts";
import * as SquireJevRouter from "./SquireJevRouter.ts";
import * as SquireLaunchAction from "./SquireLaunchAction.ts";
import * as SquireHooks from "./squireHooks.ts";
import * as SquireHtmlTools from "./SquireHtmlTools.ts";
import * as SquireLeadOnboarding from "./SquireLeadOnboarding.ts";
import * as SquireLeadRpc from "./SquireLeadRpc.ts";
import * as SquireLifecycle from "./SquireLifecycle.ts";
import * as SquireMessaging from "./SquireMessaging.ts";
import * as SquireMobileAttention from "./SquireMobileAttention.ts";
import * as SquireMcpAppRoute from "./SquireMcpAppRoute.ts";
import * as SquireOverlap from "./SquireOverlap.ts";
import * as SquirePolicyLock from "./SquirePolicyLock.ts";
import * as SquirePresence from "./SquirePresence.ts";
import * as SquireProbe from "./SquireProbe.ts";
import * as SquireReactor from "./SquireReactor.ts";
import * as SquireReadModel from "./SquireReadModel.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRooms from "./SquireRooms.ts";
import * as SquireRoomStore from "./SquireRoomStore.ts";
import * as SquireRoomTools from "./SquireRoomTools.ts";
import * as SquireRules from "./SquireRules.ts";
import * as SquireRunSource from "./SquireRunSource.ts";
import * as SquireScope from "./SquireScope.ts";
import * as SquireService from "./SquireService.ts";
import * as SquireShowcase from "./SquireShowcase.ts";
import * as SquireSummaries from "./SquireSummaries.ts";
import * as SquireSweep from "./SquireSweep.ts";
import * as SquireToolKit from "./squireToolKit.ts";
import * as SquireTools from "./SquireTools.ts";
import * as SquireTriggers from "./SquireTriggers.ts";
import * as SquireWorkspace from "./SquireWorkspace.ts";

// The reactor reads the lifecycle, rules, and policy lock with `serviceOption`, so they must sit below it here:
// a missing one would silently skip re-homing, rule disabling, or the lock instead of failing the build.
// The fixture seam and its synthetic Stave memberships exist only with test providers on.
const testProvidersOnly = <ROut, E, RIn>(layer: Layer.Layer<ROut, E, RIn>) =>
  Layer.unwrap(
    Effect.map(HostProcess.Environment, (environment) => {
      const on: Layer.Layer<never, E, RIn> = layer;
      return environment.LECTURN_TEST_PROVIDERS === "1" ? on : Layer.empty;
    }),
  );

const layerServices = Layer.mergeAll(
  testProvidersOnly(SquireDevFixtures.layer),
  // The RPC seams (SquireRpcHandlers.ts) sit on top, so they see every service below.
  SquireReadModel.layer,
  SquireLeadRpc.layer,
  // Read by AgentAwarenessRelay for the Squire phone row.
  SquireMobileAttention.layer,
).pipe(
  // Lead services, below the RPC seam that delegates to them.
  Layer.provideMerge(
    Layer.mergeAll(
      SquireLeadOnboarding.layer,
      SquireOverlap.layer,
      SquireShowcase.layer,
      SquireMcpAppRoute.layer,
      // The locked page tools, for every role. The headless browser install
      // lives under the Lecturn home, so the MCP route's html tools share it.
      SquireHtmlTools.layer.pipe(
        Layer.provide(HtmlRender.layer),
        Layer.provide(PreviewBrowser.layer.pipe(Layer.provide(FetchHttpClient.layer))),
      ),
    ),
  ),
  // Above delivery, so a decision card can wake the Lead.
  Layer.provideMerge(SquireTools.layer),
  Layer.provideMerge(SquireClock.layer),
  // Read by the clock, the tools (findings), and the RPC seam; the digest reads the sweep.
  Layer.provideMerge(SquireDigest.layer),
  Layer.provideMerge(SquireSweep.layer),
  // Messaging and room tools (7b) register into the tool registry; the clock
  // reads the proposal expiry.
  Layer.provideMerge(Layer.mergeAll(SquireMessaging.layer, SquireRoomTools.layer)),
  // Below the clock, which arms on held actions; above the reactor, items,
  // rules, and delivery it reads with `serviceOption`.
  Layer.provideMerge(SquireActions.layer),
  // Below the actions, which execute a Lead's room open, and the RPC seam.
  Layer.provideMerge(
    SquireRooms.layer.pipe(
      Layer.provideMerge(
        SquireJevRouter.layerRouting.pipe(Layer.provideMerge(SquireJevRouter.layerRelay)),
      ),
    ),
  ),
  // Lead control and Squire-create executions, read by SquireActions.
  Layer.provideMerge(SquireControl.layer),
  // Below the tools and the clock, which hold intents and arm on escalate_at.
  Layer.provideMerge(SquirePresence.layer),
  Layer.provideMerge(SquireReactor.layer),
  // The reactor hands a probe's finished run to SquireProbe.
  Layer.provideMerge(
    Layer.mergeAll(
      SquireDelivery.layer,
      SquireItems.layer,
      SquireTriggers.layer,
      SquireProbe.layer,
      SquireCiExcerpt.layer.pipe(Layer.provide(SquireCiExcerpt.layerSourceFromRegistry)),
    ),
  ),
  Layer.provideMerge(SquireSummaries.layer.pipe(Layer.provideMerge(SquireRunSource.layer))),
  Layer.provideMerge(SquireService.layer),
  Layer.provideMerge(SquireRules.layer),
  Layer.provideMerge(SquireScope.layer),
  Layer.provideMerge(Layer.mergeAll(SquireLifecycle.layer, SquireContainers.layer)),
  Layer.provideMerge(
    Layer.mergeAll(
      SquireWorkspace.layer.pipe(Layer.provide(VcsProcess.layer)),
      SquirePolicyLock.layer,
      SquireLaunchAction.layer.pipe(
        Layer.provide(CommandReceiptStore.layerFromApplicationReceipts),
      ),
      testProvidersOnly(SquireContainers.layerFixtureStave),
    ),
  ),
  // The clock's prune runs git. Its ticks come from the runtime's Scheduler,
  // required here rather than built, so the server keeps one 5 s ticker.
  Layer.provideMerge(VcsProcess.layer),
  // One registry for the whole stack: feature layers register their tool
  // handlers into it and SquireTools reads it, so their order does not matter.
  Layer.provideMerge(Layer.mergeAll(SquireToolKit.layer, SquireHooks.layer, SquireRoomStore.layer)),
);

// Built first, so the start's cursor sync precedes anything a Squire service commits.
const layerWithCursor = layerServices.pipe(Layer.provideMerge(SquireCursorStartup.layer));

// Promises no service: consumers reach them with `serviceOption`, so focused
// runtimes built without Squires still start.
const layerOpaque: Layer.Layer<
  never,
  Layer.Error<typeof layerWithCursor>,
  Layer.Services<typeof layerWithCursor>
> = layerWithCursor;

export const layer = layerOpaque.pipe(Layer.provide(SquireRepository.layer));

/**
 * The server's database storage branch, named so its test builds what the
 * server builds. Maintenance is exposed for that test; compaction keeps the
 * PR link events a Squire has not consumed.
 */
export const layerDatabaseStorage = DatabaseStorage.layer.pipe(
  Layer.provideMerge(
    ProjectionMaintenance.layer.pipe(
      Layer.provide(SquireCompactionFloor.layer.pipe(Layer.provide(SquireRepository.layer))),
    ),
  ),
  Layer.provide(
    Layer.merge(EventStoreV2.layerFromOrchestrationEventStore, ProjectionStoreV2.layer),
  ),
);
