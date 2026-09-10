import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export class StaveLifecycleService extends Context.Service<
  StaveLifecycleService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration/Services/StaveLifecycleService") {}
