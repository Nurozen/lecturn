import { SquireError, SquireRpcs, WS_METHODS as M } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import * as SquireActions from "./SquireActions.ts";
import * as SquireItems from "./SquireItems.ts";
import * as SquireLeadRpc from "./SquireLeadRpc.ts";
import { orSquireError } from "./SquireLifecycle.ts";
import * as SquirePresence from "./SquirePresence.ts";
import * as SquireProbe from "./SquireProbe.ts";
import * as SquireReadModel from "./SquireReadModel.ts";
import * as SquireRules from "./SquireRules.ts";
import * as SquireService from "./SquireService.ts";
import * as SquireSwitch from "./SquireSwitch.ts";
import * as SquireTriggers from "./SquireTriggers.ts";

// Only for typing the handler record; ws.ts serves these through its own group.
const SquireRpcGroup = RpcGroup.make(...SquireRpcs);

const disabled = new SquireError({
  code: "disabled_by_server",
  message: "Squires are disabled on this server.",
});

/**
 * Server-lifetime handlers for every Squire RPC. A focused runtime may lack a
 * service, so each is resolved as an option, and every method refuses
 * `disabled_by_server` when the switch reads off at the call or its service is
 * absent: the switch is unbypassable, like Stave's.
 */
export const make = Effect.fn("SquireRpcHandlers.make")(function* () {
  const squireSwitch = yield* SquireSwitch.SquireSwitch;
  // `refresh`, so a call that follows the client's own settings write sees it.
  const requireOn = Effect.flatMap(squireSwitch.refresh, (on) =>
    on ? Effect.void : Effect.fail(disabled),
  );
  const readModel = yield* Effect.serviceOption(SquireReadModel.SquireReadModel);
  const service = yield* Effect.serviceOption(SquireService.SquireService);
  const items = yield* Effect.serviceOption(SquireItems.SquireItems);
  const rules = yield* Effect.serviceOption(SquireRules.SquireRules);
  const triggers = yield* Effect.serviceOption(SquireTriggers.SquireTriggers);
  const actions = yield* Effect.serviceOption(SquireActions.SquireActions);
  const probe = yield* Effect.serviceOption(SquireProbe.SquireProbe);
  const presence = yield* Effect.serviceOption(SquirePresence.SquirePresence);
  const lead = yield* Effect.serviceOption(SquireLeadRpc.SquireLeadRpc);

  const use =
    <S>(option: Option.Option<S>) =>
    <A>(run: (service: S) => Effect.Effect<A, SquireError>): Effect.Effect<A, SquireError> =>
      Option.isSome(option) ? Effect.andThen(requireOn, run(option.value)) : Effect.fail(disabled);
  const withReadModel = use(readModel);
  const withService = use(service);
  const withItems = use(items);
  const withRules = use(rules);
  const withTriggers = use(triggers);
  const withActions = use(actions);
  const withProbe = use(probe);
  const withPresence = use(presence);
  const withLead = use(lead);

  return SquireRpcGroup.of({
    // Read-only: the Lead appears here only after `squire.lead.ensure` made it.
    [M.squireSubscribe]: () =>
      Option.isSome(readModel)
        ? Stream.unwrap(Effect.as(requireOn, readModel.value.subscribe))
        : Stream.fail(disabled),
    [M.squireItemsList]: (input) => withReadModel((model) => model.itemsList(input)),
    [M.squireItemGet]: ({ cardId }) =>
      withItems((service) =>
        service.get(cardId).pipe(
          orSquireError("read the item"),
          Effect.flatMap((card) =>
            Option.isSome(card)
              ? Effect.succeed({ card: card.value })
              : Effect.fail(
                  new SquireError({ code: "not_found", message: "This item no longer exists." }),
                ),
          ),
        ),
      ),
    [M.squireSummaryGet]: (input) => withReadModel((model) => model.summaryGet(input)),
    [M.squireActionLogList]: (input) => withReadModel((model) => model.actionLogList(input)),
    [M.squireVocabulary]: () => withReadModel((model) => model.vocabulary),
    [M.squireRoomPosts]: (input) => withLead((service) => service.roomPosts(input)),
    [M.squireRuleList]: ({ squireId }) =>
      withRules((service) =>
        service.list(squireId).pipe(
          orSquireError("list the rules"),
          Effect.map((rules) => ({ rules })),
        ),
      ),
    [M.squireTriggerList]: ({ squireId }) =>
      withTriggers((service) =>
        service.list(squireId).pipe(Effect.map((triggers) => ({ triggers }))),
      ),
    [M.squireTriggerRuns]: (input) => withReadModel((model) => model.triggerRuns(input)),
    [M.squireLeadReceipts]: (input) => withLead((service) => service.receipts(input)),
    [M.squireCreate]: (input) =>
      withService((service) => service.create(input).pipe(Effect.map((squire) => ({ squire })))),
    [M.squireUpdate]: (input) =>
      withService((service) => service.update(input).pipe(Effect.map((squire) => ({ squire })))),
    [M.squireSetStatus]: (input) =>
      withService((service) => service.setStatus(input).pipe(Effect.map((squire) => ({ squire })))),
    [M.squireDelete]: (input) => withService((service) => service.delete(input)),
    [M.squireTrack]: (input) =>
      withService((service) => service.track(input).pipe(Effect.map((squire) => ({ squire })))),
    [M.squireUntrack]: (input) =>
      withService((service) => service.untrack(input).pipe(Effect.map((squire) => ({ squire })))),
    [M.squireItemsAct]: (input) => withActions((service) => service.act(input)),
    [M.squireItemAsk]: (input) => withProbe((service) => service.ask(input)),
    [M.squireVoiceNote]: (input) => withService((service) => service.voiceNote(input)),
    [M.squireLeadEnsure]: (input) =>
      withService((service) =>
        service.ensureLead(input).pipe(
          Effect.flatMap((squire) =>
            Option.isSome(squire)
              ? Effect.succeed({ squire: squire.value })
              : Effect.fail(
                  new SquireError({
                    code: "not_available",
                    message: "The Lead needs a project. Add a project first.",
                  }),
                ),
          ),
        ),
      ),
    [M.squireLeadOpen]: (input) => withLead((service) => service.open(input)),
    [M.squireControlRevert]: (input) => withLead((service) => service.revertControl(input)),
    [M.squireItemsMarkOpened]: (input) => withPresence((service) => service.markOpened(input)),
    [M.squireRuleCreate]: (input) =>
      withRules((service) =>
        service.create(input).pipe(
          orSquireError("save the rule"),
          Effect.map((rule) => ({ rule })),
        ),
      ),
    [M.squireRuleRemove]: (input) =>
      withRules((service) => service.remove(input).pipe(orSquireError("remove the rule"))),
    [M.squireTriggerCreate]: (input) => withTriggers((service) => service.create(input)),
    [M.squireTriggerUpdate]: (input) => withTriggers((service) => service.update(input)),
    [M.squireTriggerRotate]: (input) => withTriggers((service) => service.rotate(input)),
    [M.squireTriggerRevoke]: (input) => withTriggers((service) => service.revoke(input)),
    [M.squireTriggerTest]: (input) => withTriggers((service) => service.test(input)),
    [M.squireAutomationResume]: (input) => withLead((service) => service.resumeAutomation(input)),
    [M.squireLeadSweep]: (input) => withLead((service) => service.sweep(input)),
    [M.squireRoomCreate]: (input) => withLead((service) => service.roomCreate(input)),
    [M.squireRoomUpdate]: (input) => withLead((service) => service.roomUpdate(input)),
    [M.squireRoomClose]: (input) => withLead((service) => service.roomClose(input)),
    [M.squireRoomReopen]: (input) => withLead((service) => service.roomReopen(input)),
    [M.squireRoomPost]: (input) => withLead((service) => service.roomPost(input)),
    [M.squireRoomReroute]: (input) => withLead((service) => service.roomReroute(input)),
    [M.squireRoomMarkRead]: (input) => withLead((service) => service.roomMarkRead(input)),
    [M.squireNotificationAlerted]: (input) => withPresence((service) => service.markAlerted(input)),
    [M.squireGet]: ({ squireId }) =>
      withService((service) =>
        service.get(squireId).pipe(
          Effect.flatMap((squire) =>
            Option.isSome(squire)
              ? Effect.succeed({ squire: squire.value })
              : Effect.fail(
                  new SquireError({
                    code: "not_found",
                    message: "This Squire no longer exists.",
                  }),
                ),
          ),
        ),
      ),
    [M.squireProviderSupport]: () => withService((service) => service.providerSupport),
  });
});

export type SquireRpcHandlers = Effect.Success<ReturnType<typeof make>>;
