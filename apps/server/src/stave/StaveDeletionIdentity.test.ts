import { assert, it } from "@effect/vitest";
import { Effect, Option, Ref } from "effect";

import { bindStaveDeletionIdentity } from "./StaveDeletionIdentity.ts";
import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";

const CREATED_AT = "2026-09-01T00:00:00.123456789Z";

it.effect("binds the fresh manifest incarnation of the deleted root", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const reader = StaveWorkspaceReader.of({
      invalidate: (root) => Ref.update(calls, (all) => [...all, `invalidate:${root}`]),
      invalidateAll: () => Effect.void,
      load: (root) =>
        Ref.update(calls, (all) => [...all, `load:${root}`]).pipe(
          Effect.as(
            root === "/space"
              ? Option.some({
                  spaceId: "space",
                  createdAt: CREATED_AT,
                  isSaga: false,
                  repos: [],
                  memories: [],
                })
              : Option.none(),
          ),
        ),
    });
    const bound = yield* bindStaveDeletionIdentity("/space").pipe(
      Effect.provideService(StaveWorkspaceReader, reader),
    );
    assert.deepEqual(bound, { staveSpaceId: "space", staveCreatedAt: CREATED_AT });
    // The cached manifest never answers for a deletion.
    assert.deepEqual(yield* Ref.get(calls), ["invalidate:/space", "load:/space"]);
    assert.deepEqual(
      yield* bindStaveDeletionIdentity("/plain").pipe(
        Effect.provideService(StaveWorkspaceReader, reader),
      ),
      {},
    );
  }),
);

it.effect("binds nothing when Stave is not wired", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* bindStaveDeletionIdentity("/space"), {});
  }),
);
