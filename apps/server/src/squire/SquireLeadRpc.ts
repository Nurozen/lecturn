import {
  SquireError,
  type SquireAutomationResumeInput,
  type SquireAutomationResumeResult,
  type SquireControlRevertInput,
  type SquireLeadOpenInput,
  type SquireLeadOpenResult,
  type SquireLeadReceiptsInput,
  type SquireLeadReceiptsResult,
  type SquireLeadSweepInput,
  type SquireLeadSweepResult,
  type SquireResult,
  type SquireRoomCloseInput,
  type SquireRoomCreateInput,
  type SquireRoomMarkReadInput,
  type SquireRoomMarkReadResult,
  type SquireRoomPostInput,
  type SquireRoomPostResult,
  type SquireRoomPostsInput,
  type SquireRoomPostsResult,
  type SquireRoomReopenInput,
  type SquireRoomRerouteInput,
  type SquireRoomResult,
  type SquireRoomUpdateInput,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SquireControl from "./SquireControl.ts";
import * as SquireLeadOnboarding from "./SquireLeadOnboarding.ts";
import * as SquireLeadReceipts from "./SquireLeadReceipts.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRooms from "./SquireRooms.ts";
import * as SquireSweep from "./SquireSweep.ts";
import * as SquireTriggers from "./SquireTriggers.ts";

type Method<I extends { readonly Type: unknown }, O extends { readonly Type: unknown }> = (
  input: I["Type"],
) => Effect.Effect<O["Type"], SquireError>;

/**
 * The Lead, control, sweep, routing, and room methods the RPC layer serves.
 * A method whose service is not built into the server refuses
 * `not_available`, so the transport and its scopes stay the same either way.
 */
export class SquireLeadRpc extends Context.Service<
  SquireLeadRpc,
  {
    readonly open: Method<typeof SquireLeadOpenInput, typeof SquireLeadOpenResult>;
    readonly revertControl: Method<typeof SquireControlRevertInput, typeof SquireResult>;
    readonly sweep: Method<typeof SquireLeadSweepInput, typeof SquireLeadSweepResult>;
    readonly receipts: Method<typeof SquireLeadReceiptsInput, typeof SquireLeadReceiptsResult>;
    readonly resumeAutomation: Method<
      typeof SquireAutomationResumeInput,
      typeof SquireAutomationResumeResult
    >;
    readonly roomPosts: Method<typeof SquireRoomPostsInput, typeof SquireRoomPostsResult>;
    readonly roomCreate: Method<typeof SquireRoomCreateInput, typeof SquireRoomResult>;
    readonly roomUpdate: Method<typeof SquireRoomUpdateInput, typeof SquireRoomResult>;
    readonly roomClose: Method<typeof SquireRoomCloseInput, typeof SquireRoomResult>;
    readonly roomReopen: Method<typeof SquireRoomReopenInput, typeof SquireRoomResult>;
    readonly roomPost: Method<typeof SquireRoomPostInput, typeof SquireRoomPostResult>;
    readonly roomReroute: Method<typeof SquireRoomRerouteInput, typeof SquireRoomPostResult>;
    readonly roomMarkRead: Method<typeof SquireRoomMarkReadInput, typeof SquireRoomMarkReadResult>;
  }
>()("lecturn/squire/SquireLeadRpc") {}

const notAvailable = (what: string) => () =>
  Effect.fail(
    new SquireError({
      code: "not_available",
      message: `${what} is not available on this server yet.`,
    }),
  );

// Each service is read optionally, so a method stays `not_available`
// until the service that owns it is built into the server.
export const layer = Layer.effect(
  SquireLeadRpc,
  Effect.gen(function* () {
    const onboarding = yield* Effect.serviceOption(SquireLeadOnboarding.SquireLeadOnboarding);
    const triggers = yield* Effect.serviceOption(SquireTriggers.SquireTriggers);
    const sweeps = yield* Effect.serviceOption(SquireSweep.SquireSweep);
    const control = yield* Effect.serviceOption(SquireControl.SquireControl);
    const repository = yield* Effect.serviceOption(SquireRepository.SquireRepository);
    const rooms = yield* Effect.serviceOption(SquireRooms.SquireRooms);
    const room = <
      K extends
        | "posts"
        | "create"
        | "update"
        | "close"
        | "reopen"
        | "userPost"
        | "reroute"
        | "markRead",
    >(
      method: K,
    ) =>
      Option.match(rooms, {
        onNone: () => notAvailable("Squire rooms"),
        onSome: (service) => service[method],
      });
    return SquireLeadRpc.of({
      open: Option.match(onboarding, {
        onNone: () => notAvailable("Opening the Lead"),
        onSome: (service) => service.open,
      }),
      revertControl: Option.match(control, {
        onNone: () => notAvailable("Reverting a Lead control action"),
        onSome: (service) => service.revert,
      }),
      sweep: Option.match(sweeps, {
        onNone: () => notAvailable("Find work"),
        onSome: (service) => service.request,
      }),
      receipts: Option.match(repository, {
        onNone: () => notAvailable("Routing receipts"),
        onSome: (service) => (input: typeof SquireLeadReceiptsInput.Type) =>
          SquireLeadReceipts.list(input).pipe(
            Effect.provideService(SquireRepository.SquireRepository, service),
          ),
      }),
      resumeAutomation: Option.match(triggers, {
        onNone: () => notAvailable("Resuming automation"),
        onSome: (service) => service.resumeAutomation,
      }),
      roomPosts: room("posts"),
      roomCreate: room("create"),
      roomUpdate: room("update"),
      roomClose: room("close"),
      roomReopen: room("reopen"),
      roomPost: room("userPost"),
      roomReroute: room("reroute"),
      roomMarkRead: room("markRead"),
    });
  }),
);
